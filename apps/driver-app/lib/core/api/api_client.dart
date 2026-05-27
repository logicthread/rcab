import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../auth/token_store.dart';

/// Builds the app-wide dio instance.
///
/// [onSignOut] is called when a token refresh fails (401 on the refresh
/// endpoint) so the auth notifier can clear state without a circular import.
Dio buildApiClient({
  required String baseUrl,
  required TokenStore tokenStore,
  required Future<void> Function() onSignOut,
  bool enableLogging = false,
  @visibleForTesting Dio? refreshDio,
}) {
  final dio = Dio(BaseOptions(baseUrl: baseUrl));

  if (enableLogging) {
    dio.interceptors.add(LogInterceptor(
      requestBody: true,
      responseBody: true,
    ));
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

/// Attaches the JWT on every request; handles transparent token refresh.
///
/// On a 401 response the interceptor:
///   1. Calls POST /v1/auth/refresh with the stored refresh token.
///   2. On success — saves the new JWT and retries the original request.
///   3. On failure — calls [onSignOut] and surfaces the original error.
///
/// Uses a separate Dio instance for the refresh call to avoid re-entering
/// this interceptor recursively.
class JwtRefreshInterceptor extends Interceptor {
  JwtRefreshInterceptor({
    required String baseUrl,
    required TokenStore tokenStore,
    required Future<void> Function() onSignOut,
    @visibleForTesting Dio? refreshDio,
  })  : _tokenStore = tokenStore,
        _onSignOut = onSignOut,
        _refreshDio = refreshDio ?? Dio(BaseOptions(baseUrl: baseUrl));

  final TokenStore _tokenStore;
  final Future<void> Function() _onSignOut;
  final Dio _refreshDio;
  bool _isRefreshing = false;

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
    if (err.response?.statusCode != 401 || _isRefreshing) {
      return handler.next(err);
    }

    _isRefreshing = true;
    try {
      final refresh = await _tokenStore.getRefresh();
      if (refresh == null) {
        await _onSignOut();
        return handler.next(err);
      }

      final Response<Map<String, dynamic>> refreshResponse;
      try {
        refreshResponse = await _refreshDio.post<Map<String, dynamic>>(
          '/v1/auth/refresh',
          data: {'refresh_token': refresh},
        );
      } on DioException {
        await _onSignOut();
        return handler.next(err);
      }

      final newJwt = refreshResponse.data?['rcab_jwt'] as String?;
      if (newJwt == null) {
        await _onSignOut();
        return handler.next(err);
      }

      final newRefresh =
          refreshResponse.data?['refresh_token'] as String? ?? refresh;
      await _tokenStore.saveTokens(jwt: newJwt, refresh: newRefresh);

      // Retry the original request with the new token.
      final retryOptions = err.requestOptions;
      retryOptions.headers['Authorization'] = 'Bearer $newJwt';
      final retried = await _refreshDio.fetch<dynamic>(retryOptions);
      handler.resolve(retried);
    } finally {
      _isRefreshing = false;
    }
  }
}
