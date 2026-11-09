import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_state.dart';
import 'native_auth_contract.dart';
import 'token_store.dart';
import '../config/policy.dart';

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier(
    this._tokenStore,
    this._firebaseAuth,
    this._dio, {
    AuthState? initialState,
  }) : super(initialState ?? const AuthStateUnauthenticated()) {
    // Restore session on cold start only when no initial state was supplied.
    // Tests supply either initialState or set state via ..state = after construction.
    if (initialState == null) _restoreSession();
  }

  final TokenStore _tokenStore;
  final FirebaseAuth _firebaseAuth;
  final Dio _dio;

  /// Exchanges a Firebase ID token for rcab credentials.
  ///
  /// Returns null on success, or an error message string on failure.
  Future<String?> signInWithFirebaseToken(String idToken) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        NativeAuthContract.firebaseExchangePath,
        data: {'id_token': idToken},
      );
      final session = NativeSession.tryParse(response.data);
      if (session == null) return 'Sign-in failed';
      await _tokenStore.saveTokens(
        jwt: session.accessToken,
        refresh: session.refreshToken,
      );
      state = AuthStateAuthenticated(
        userId: session.userId,
        role: session.role,
      );
      return null;
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      return status != null ? 'Sign-in failed ($status)' : 'Network error';
    } catch (_) {
      return 'Sign-in failed';
    }
  }

  /// Signs out: best-effort server-side revocation, then always clears the
  /// device (secure storage + Firebase), even when offline.
  ///
  /// Native logout is possession-based: the refresh token in the body is the
  /// only credential, so sign-out still revokes the session after the access
  /// token has expired (e.g. the app idled > 15 min). No Bearer header is sent.
  ///
  /// Server revocation is only guaranteed when the device is online; an
  /// offline sign-out leaves the refresh token valid server-side until expiry.
  Future<void> signOut() async {
    String? refresh;
    try {
      refresh = await _tokenStore.getRefresh();
    } catch (_) {}

    if (refresh != null) {
      try {
        await _dio.post<dynamic>(
          NativeAuthContract.logoutPath,
          data: {'refresh_token': refresh},
          options: Options(
            sendTimeout: DriverPolicy.logoutTimeout,
            receiveTimeout: DriverPolicy.logoutTimeout,
          ),
        );
      } catch (_) {
        // Best effort: offline or server error. The server always answers
        // 204 for a well-formed body, even for an unknown/revoked token.
      }
    }

    // Clear local credentials even if the call above failed; the interceptor
    // re-checks the store so a late refresh cannot restore the session.
    try {
      await _tokenStore.clear();
    } finally {
      try {
        await _firebaseAuth.signOut();
      } catch (_) {}
      if (mounted) state = const AuthStateUnauthenticated();
    }
  }

  Future<void> _restoreSession() async {
    final jwt = await _tokenStore.getJwt();
    if (jwt == null || !mounted) return;
    final claims = _decodeJwtPayload(jwt);
    final userId = claims['sub'] as String?;
    if (userId == null || userId.isEmpty) return;
    state = AuthStateAuthenticated(
      userId: userId,
      role: (claims['role'] as String?) ?? 'driver',
    );
  }

  static Map<String, dynamic> _decodeJwtPayload(String jwt) {
    try {
      final parts = jwt.split('.');
      if (parts.length != 3) return {};
      final payload = utf8.decode(
        base64Url.decode(base64Url.normalize(parts[1])),
      );
      return jsonDecode(payload) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }
}
