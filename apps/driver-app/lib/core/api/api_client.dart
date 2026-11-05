import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../auth/native_auth_contract.dart';
import '../auth/token_store.dart';

/// Builds the app-wide dio instance.
///
/// [onSignOut] is called when a token refresh is rejected by the server so
/// the auth notifier can clear state without a circular import.
Dio buildApiClient({
  required String baseUrl,
  required TokenStore tokenStore,
  required Future<void> Function() onSignOut,
  bool enableLogging = false,
  @visibleForTesting Dio? refreshDio,
}) {
  final dio = Dio(BaseOptions(baseUrl: baseUrl));

  if (enableLogging) {
    dio.interceptors.add(LogInterceptor(requestBody: true, responseBody: true));
  }

  dio.interceptors.add(
    JwtRefreshInterceptor(
      baseUrl: baseUrl,
      tokenStore: tokenStore,
      onSignOut: onSignOut,
      refreshDio: refreshDio,
    ),
  );

  return dio;
}

/// Result of one refresh attempt, shared by every request awaiting it.
class _RefreshResult {
  const _RefreshResult.success(this.accessToken) : transientFailure = false;
  const _RefreshResult.rejected()
    : accessToken = null,
      transientFailure = false;
  const _RefreshResult.transient()
    : accessToken = null,
      transientFailure = true;

  /// New access token, or null when the refresh did not succeed.
  final String? accessToken;

  /// True when the failure was network/5xx: the session is kept so a later
  /// request can try again. The refresh token MAY already have been consumed
  /// (the server rotated it but the response was lost). A retry within the
  /// server's 10 s reuse-grace window then gets a plain 401 (no family
  /// revocation) and the user signs in again; a retry after the window is
  /// treated as replay and revokes the session — either way, sign-in.
  final bool transientFailure;
}

/// Attaches the JWT on every request; handles transparent token refresh.
///
/// On a 401 response the interceptor:
///   1. Calls POST /v1/auth/native/refresh with the stored refresh token.
///      The refresh token is single-use and rotated; concurrent 401s share
///      one in-flight refresh (single-flight) and each retries exactly once
///      with the new access token.
///   2. On success — persists the rotated access + refresh tokens, then
///      retries the original request.
///   3. On rejection (4xx / malformed body / no refresh token) — calls
///      [onSignOut] and surfaces the original error. Network errors and 5xx
///      keep the session and surface the original error.
///
/// Uses a separate Dio instance for the refresh call to avoid re-entering
/// this interceptor recursively.
class JwtRefreshInterceptor extends Interceptor {
  JwtRefreshInterceptor({
    required String baseUrl,
    required TokenStore tokenStore,
    required Future<void> Function() onSignOut,
    @visibleForTesting Dio? refreshDio,
  }) : _tokenStore = tokenStore,
       _onSignOut = onSignOut,
       _refreshDio = refreshDio ?? Dio(BaseOptions(baseUrl: baseUrl));

  static const _retriedKey = 'rcab_auth_retried';

  final TokenStore _tokenStore;
  final Future<void> Function() _onSignOut;
  final Dio _refreshDio;
  Future<_RefreshResult>? _inFlight;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    final jwt = await _tokenStore.getJwt();
    if (jwt != null) {
      options.headers['Authorization'] = 'Bearer $jwt';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final options = err.requestOptions;
    // Retry at most once per request.
    if (err.response?.statusCode != 401 || options.extra[_retriedKey] == true) {
      return handler.next(err);
    }

    // Another request may already have rotated the tokens while this one was
    // in flight: if the stored JWT differs from the one this request sent,
    // just retry with the current one instead of burning another refresh.
    final current = await _tokenStore.getJwt();
    final sent = options.headers['Authorization'];
    String? accessToken;
    if (current != null && sent != 'Bearer $current') {
      accessToken = current;
    } else {
      final result = await (_inFlight ??= _refresh().whenComplete(() {
        _inFlight = null;
      }));
      accessToken = result.accessToken;
    }

    if (accessToken == null) return handler.next(err);

    options.extra[_retriedKey] = true;
    options.headers['Authorization'] = 'Bearer $accessToken';
    try {
      handler.resolve(await _refreshDio.fetch<dynamic>(options));
    } on DioException catch (e) {
      handler.next(e);
    }
  }

  /// Performs the single refresh round-trip. Never throws.
  Future<_RefreshResult> _refresh() async {
    final refresh = await _tokenStore.getRefresh();
    if (refresh == null) {
      await _onSignOut();
      return const _RefreshResult.rejected();
    }

    final Response<Map<String, dynamic>> response;
    try {
      response = await _refreshDio.post<Map<String, dynamic>>(
        NativeAuthContract.refreshPath,
        data: {'refresh_token': refresh},
      );
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      if (status == null || status >= 500) {
        // Keep the session, but the token may have been consumed server-side
        // (see [_RefreshResult.transientFailure]); a later retry can 401.
        return const _RefreshResult.transient();
      }
      await _signOutIfUnchanged(refresh);
      return const _RefreshResult.rejected();
    }

    final session = NativeSession.tryParse(response.data);
    if (session == null) {
      await _signOutIfUnchanged(refresh);
      return const _RefreshResult.rejected();
    }

    // A sign-out (or another session) may have replaced the stored refresh
    // token while the request was in flight: never resurrect it.
    if (await _tokenStore.getRefresh() != refresh) {
      return const _RefreshResult.rejected();
    }

    // Persist both rotated credentials before releasing queued requests.
    await _tokenStore.saveTokens(
      jwt: session.accessToken,
      refresh: session.refreshToken,
    );
    return _RefreshResult.success(session.accessToken);
  }

  Future<void> _signOutIfUnchanged(String usedRefresh) async {
    if (await _tokenStore.getRefresh() == usedRefresh) {
      await _onSignOut();
    }
  }
}
