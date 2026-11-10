import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'auth_state.dart';
import 'native_auth_contract.dart';
import 'sign_in_errors.dart';
import 'token_store.dart';
import '../config/policy.dart';

/// Builds the Google sign-in client for a given web client id. Injected so
/// tests can supply a mock; the default requests the `email` scope and the
/// ID token for [serverClientId].
typedef GoogleSignInFactory = GoogleSignIn Function(String? serverClientId);

GoogleSignIn defaultGoogleSignInFactory(String? serverClientId) =>
    GoogleSignIn(serverClientId: serverClientId, scopes: const ['email']);

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier(
    this._tokenStore,
    this._firebaseAuth,
    this._dio, {
    AuthState? initialState,
    GoogleSignInFactory googleSignInFactory = defaultGoogleSignInFactory,
  })  : _googleSignInFactory = googleSignInFactory,
        super(initialState ?? const AuthStateUnauthenticated()) {
    // Restore session on cold start only when no initial state was supplied.
    // Tests supply either initialState or set state via ..state = after construction.
    if (initialState == null) _restoreSession();
  }

  final TokenStore _tokenStore;
  final FirebaseAuth _firebaseAuth;
  final Dio _dio;
  final GoogleSignInFactory _googleSignInFactory;

  /// The Google client of the last [signInWithGoogle], so [signOut] clears
  /// the same cached account.
  GoogleSignIn? _googleSignIn;

  /// Exchanges a Firebase ID token for rcab credentials (phone/OTP path;
  /// the API refuses it with `auth_method_disabled` while phone is off).
  ///
  /// Returns null on success, or an error message string on failure.
  Future<String?> signInWithFirebaseToken(String idToken) =>
      _exchange(NativeAuthContract.firebaseExchangePath, idToken);

  /// Google sign-in (RCAB-E8.S15): picks an account, takes its ID token
  /// (audience = [serverClientId], the API's web client id) and exchanges it
  /// at `POST /v1/auth/native/google`. Logs in by Google subject, or
  /// registers a new account on first use.
  ///
  /// Returns null on success **and** when the user dismissed the account
  /// picker (state stays unauthenticated); otherwise an error message.
  Future<String?> signInWithGoogle({String? serverClientId}) async {
    final String? idToken;
    try {
      final google = _googleSignInFactory(serverClientId);
      _googleSignIn = google;
      final account = await google.signIn();
      if (account == null) return null; // cancelled
      idToken = (await account.authentication).idToken;
    } catch (_) {
      return 'Google sign-in failed. Check your connection and try again.';
    }
    if (idToken == null || idToken.isEmpty) {
      // No ID token means the OAuth client is not set up for this build.
      return 'Google sign-in is not set up for this build. Contact support.';
    }
    return _exchange(NativeAuthContract.googlePath, idToken);
  }

  /// Re-checks the account by rotating the refresh token at
  /// `POST /v1/auth/native/refresh`. The API reads the role from the database
  /// on every refresh, so an operator enabling this account as a driver takes
  /// effect here without signing in again (RCAB-E8.S15).
  ///
  /// Returns null on success (state updated with the current role). A
  /// rejected refresh (4xx) signs out; a network/5xx failure keeps the
  /// session and returns an error message.
  Future<String?> refreshSession() async {
    final refresh = await _tokenStore.getRefresh();
    if (refresh == null || refresh.isEmpty) {
      await signOut();
      return null;
    }
    final Response<Map<String, dynamic>> response;
    try {
      response = await _dio.post<Map<String, dynamic>>(
        NativeAuthContract.refreshPath,
        data: {'refresh_token': refresh},
      );
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      if (status != null && status < 500) {
        await signOut();
        return null;
      }
      return 'Could not reach the server. Check your connection and try again.';
    } catch (_) {
      return 'Could not re-check your account. Try again.';
    }
    final session = NativeSession.tryParse(response.data);
    if (session == null) return 'Could not re-check your account. Try again.';
    await _tokenStore.saveTokens(
      jwt: session.accessToken,
      refresh: session.refreshToken,
    );
    final current = state;
    final email = session.email ??
        (current is AuthStateAuthenticated ? current.email : null);
    final phone = session.phoneE164 ??
        (current is AuthStateAuthenticated ? current.phoneE164 : null);
    try {
      await _tokenStore.saveAccount(email: email, phoneE164: phone);
    } catch (_) {}
    if (mounted) {
      state = AuthStateAuthenticated(
        userId: session.userId,
        role: session.role,
        email: email,
        phoneE164: phone,
      );
    }
    return null;
  }

  Future<String?> _exchange(String path, String idToken) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        path,
        data: {'id_token': idToken},
      );
      final session = NativeSession.tryParse(response.data);
      if (session == null) return 'Sign-in failed';
      await _tokenStore.saveTokens(
        jwt: session.accessToken,
        refresh: session.refreshToken,
      );
      try {
        await _tokenStore.saveAccount(
          email: session.email,
          phoneE164: session.phoneE164,
        );
      } catch (_) {
        // Display-only; never fail a sign-in over it.
      }
      state = AuthStateAuthenticated(
        userId: session.userId,
        role: session.role,
        email: session.email,
        phoneE164: session.phoneE164,
      );
      return null;
    } on DioException catch (e) {
      return signInErrorMessage(e);
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
      // Forget the cached Google account so the next sign-in shows the
      // account picker instead of silently reusing this one.
      try {
        await (_googleSignIn ?? _googleSignInFactory(null))
            .signOut()
            .timeout(const Duration(seconds: 5));
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
    var account = (email: null as String?, phoneE164: null as String?);
    try {
      account = await _tokenStore.getAccount();
    } catch (_) {
      // Display-only; the session restores without it.
    }
    if (!mounted) return;
    state = AuthStateAuthenticated(
      userId: userId,
      role: (claims['role'] as String?) ?? 'driver',
      email: account.email,
      phoneE164: account.phoneE164,
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
