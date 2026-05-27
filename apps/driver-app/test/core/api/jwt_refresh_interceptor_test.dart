import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/core/api/api_client.dart';
import 'package:driver_app/core/auth/token_store.dart';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

typedef _Handler = ResponseBody Function(RequestOptions options);

/// Synchronous in-memory HTTP adapter — no platform channels.
class _FakeAdapter implements HttpClientAdapter {
  _FakeAdapter(this._handler);
  final _Handler _handler;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      _handler(options);

  @override
  void close({bool force = false}) {}
}

ResponseBody _json(int status, Map<String, dynamic> body) {
  final bytes = utf8.encode(jsonEncode(body));
  return ResponseBody.fromBytes(
    bytes,
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );
}

/// In-memory [TokenStore] — no FlutterSecureStorage involved.
class _FakeTokenStore extends TokenStore {
  _FakeTokenStore({String? jwt, String? refresh}) {
    if (jwt != null) _data['rcab_jwt'] = jwt;
    if (refresh != null) _data['rcab_refresh_token'] = refresh;
  }

  final Map<String, String> _data = {};

  @override
  Future<void> saveTokens({required String jwt, required String refresh}) async {
    _data['rcab_jwt'] = jwt;
    _data['rcab_refresh_token'] = refresh;
  }

  @override
  Future<String?> getJwt() async => _data['rcab_jwt'];

  @override
  Future<String?> getRefresh() async => _data['rcab_refresh_token'];

  @override
  Future<void> clear() async => _data.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _baseUrl = 'https://api.test.local';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  group('JwtRefreshInterceptor — Authorization header', () {
    test('attaches Bearer token from token store on every request', () async {
      final store = _FakeTokenStore(jwt: 'stored.jwt', refresh: 'r');
      String? captured;

      final dio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async {},
        enableLogging: false,
        refreshDio: Dio(BaseOptions(baseUrl: _baseUrl))
          ..httpClientAdapter = _FakeAdapter((_) => _json(200, {})),
      )..httpClientAdapter = _FakeAdapter((opts) {
          captured = opts.headers['Authorization'] as String?;
          return _json(200, {'ok': true});
        });

      await dio.get<dynamic>('/v1/health/ready');
      expect(captured, 'Bearer stored.jwt');
    });

    test('sends no Authorization header when no JWT is stored', () async {
      final store = _FakeTokenStore(); // empty
      String? captured = 'sentinel';

      final dio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async {},
        enableLogging: false,
        refreshDio: Dio(BaseOptions(baseUrl: _baseUrl))
          ..httpClientAdapter = _FakeAdapter((_) => _json(200, {})),
      )..httpClientAdapter = _FakeAdapter((opts) {
          captured = opts.headers['Authorization'] as String?;
          return _json(200, {});
        });

      await dio.get<dynamic>('/v1/health/ready');
      expect(captured, isNull);
    });
  });

  group('JwtRefreshInterceptor — 401 → refresh → retry', () {
    test('successful refresh: saves new JWT and retries original request',
        () async {
      final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'old-refresh');
      final signOutCalls = <String>[];

      final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
        ..httpClientAdapter = _FakeAdapter((opts) {
          if (opts.path == '/v1/auth/refresh') {
            return _json(200, {
              'rcab_jwt': 'new.jwt',
              'refresh_token': 'new-refresh',
            });
          }
          // Retry of the original request routes through _refreshDio.
          return _json(200, {'data': 'ok'});
        });

      final mainDio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async => signOutCalls.add('signOut'),
        enableLogging: false,
        refreshDio: refreshDio,
      )..httpClientAdapter = _FakeAdapter(
          // Original request always returns 401 to trigger refresh.
          (_) => _json(401, {'error': 'expired'}),
        );

      final response = await mainDio.get<dynamic>('/v1/drivers/me');

      // Key behaviours: successful response, new JWT persisted, no sign-out.
      expect(response.statusCode, 200);
      expect(signOutCalls, isEmpty);
      expect(await store.getJwt(), 'new.jwt');
      expect(await store.getRefresh(), 'new-refresh');
    });
  });

  group('JwtRefreshInterceptor — 401 → refresh failure → signOut', () {
    test('refresh returns 401: calls onSignOut and surfaces original error',
        () async {
      final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'old-refresh');
      final signOutCalls = <String>[];

      final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
        ..httpClientAdapter = _FakeAdapter(
          (_) => _json(401, {'error': 'refresh_expired'}),
        );

      final mainDio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async => signOutCalls.add('signOut'),
        enableLogging: false,
        refreshDio: refreshDio,
      )..httpClientAdapter = _FakeAdapter(
          (_) => _json(401, {'error': 'unauthorized'}),
        );

      await expectLater(
        mainDio.get<dynamic>('/v1/drivers/me'),
        throwsA(isA<DioException>()),
      );
      expect(signOutCalls, ['signOut']);
    });

    test('no refresh token stored: calls onSignOut immediately', () async {
      final store = _FakeTokenStore(jwt: 'old.jwt'); // no refresh token
      final signOutCalls = <String>[];

      final mainDio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async => signOutCalls.add('signOut'),
        enableLogging: false,
        refreshDio: Dio(BaseOptions(baseUrl: _baseUrl))
          ..httpClientAdapter = _FakeAdapter((_) => _json(200, {})),
      )..httpClientAdapter = _FakeAdapter(
          (_) => _json(401, {'error': 'unauthorized'}),
        );

      await expectLater(
        mainDio.get<dynamic>('/v1/drivers/me'),
        throwsA(isA<DioException>()),
      );
      expect(signOutCalls, ['signOut']);
    });
  });
}
