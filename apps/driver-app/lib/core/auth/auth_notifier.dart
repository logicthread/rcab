import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_state.dart';
import 'token_store.dart';

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
        '/v1/auth/firebase-exchange',
        data: {'firebase_id_token': idToken},
      );
      final data = response.data;
      if (data == null) return 'Sign-in failed';
      final jwt = data['rcab_jwt'] as String;
      final refresh = data['refresh_token'] as String;
      final userMap = data['user'] as Map<String, dynamic>;
      await _tokenStore.saveTokens(jwt: jwt, refresh: refresh);
      state = AuthStateAuthenticated(
        userId: userMap['id'] as String,
        role: (userMap['role'] as String?) ?? 'driver',
      );
      return null;
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      return status != null ? 'Sign-in failed ($status)' : 'Network error';
    } catch (_) {
      return 'Sign-in failed';
    }
  }

  Future<void> signOut() async {
    await Future.wait([
      _tokenStore.clear(),
      _firebaseAuth.signOut(),
    ]);
    state = const AuthStateUnauthenticated();
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
