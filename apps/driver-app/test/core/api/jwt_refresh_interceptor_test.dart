import 'dart:async';
import 'dart:convert';
import 'dart:io';
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
  ) async => _handler(options);

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

class _AsyncAdapter implements HttpClientAdapter {
  _AsyncAdapter(this._handler);
  final Future<ResponseBody> Function(RequestOptions) _handler;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) => _handler(options);

  @override
  void close({bool force = false}) {}
}

class _ThrowingAdapter implements HttpClientAdapter {
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => throw DioException(
    requestOptions: options,
    type: DioExceptionType.connectionError,
  );

  @override
  void close({bool force = false}) {}
}

/// Holds the refresh response until [gate] completes.
class _GatedAdapter implements HttpClientAdapter {
  _GatedAdapter(this.gate, this.body);
  final Future<void> gate;
  final Map<String, dynamic> body;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    await gate;
    return _json(200, body);
  }

  @override
  void close({bool force = false}) {}
}

/// In-memory [TokenStore] — no FlutterSecureStorage involved.
class _FakeTokenStore extends TokenStore {
  _FakeTokenStore({String? jwt, String? refresh}) {
    if (jwt != null) _data['rcab_jwt'] = jwt;
    if (refresh != null) _data['rcab_refresh_token'] = refresh;
  }

  final Map<String, String> _data = {};

  @override
  Future<void> saveTokens({
    required String jwt,
    required String refresh,
  }) async {
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

/// Shared contract fixture (mirrored by the API slice).
final Map<String, dynamic> _contract =
    jsonDecode(
          File('test/fixtures/native_auth_contract.json').readAsStringSync(),
        )
        as Map<String, dynamic>;

Map<String, dynamic> get _refreshContract =>
    _contract['refresh'] as Map<String, dynamic>;
String get _refreshPath => _refreshContract['path'] as String;
Map<String, dynamic> get _refreshOk =>
    _refreshContract['response_200'] as Map<String, dynamic>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  group('JwtRefreshInterceptor — Authorization header', () {
    test('attaches Bearer token from token store on every request', () async {
      final store = _FakeTokenStore(jwt: 'stored.jwt', refresh: 'r');
      String? captured;

      final dio =
          buildApiClient(
              baseUrl: _baseUrl,
              tokenStore: store,
              onSignOut: () async {},
              enableLogging: false,
              refreshDio: Dio(BaseOptions(baseUrl: _baseUrl))
                ..httpClientAdapter = _FakeAdapter((_) => _json(200, {})),
            )
            ..httpClientAdapter = _FakeAdapter((opts) {
              captured = opts.headers['Authorization'] as String?;
              return _json(200, {'ok': true});
            });

      await dio.get<dynamic>('/v1/health/ready');
      expect(captured, 'Bearer stored.jwt');
    });

    test('sends no Authorization header when no JWT is stored', () async {
      final store = _FakeTokenStore(); // empty
      String? captured = 'sentinel';

      final dio =
          buildApiClient(
              baseUrl: _baseUrl,
              tokenStore: store,
              onSignOut: () async {},
              enableLogging: false,
              refreshDio: Dio(BaseOptions(baseUrl: _baseUrl))
                ..httpClientAdapter = _FakeAdapter((_) => _json(200, {})),
            )
            ..httpClientAdapter = _FakeAdapter((opts) {
              captured = opts.headers['Authorization'] as String?;
              return _json(200, {});
            });

      await dio.get<dynamic>('/v1/health/ready');
      expect(captured, isNull);
    });
  });

  group('JwtRefreshInterceptor — 401 → refresh → retry', () {
    test(
      'successful refresh: saves new JWT and retries original request',
      () async {
        final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'old-refresh');
        final signOutCalls = <String>[];

        Object? refreshBody;
        final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
          ..httpClientAdapter = _FakeAdapter((opts) {
            if (opts.path == _refreshPath) {
              refreshBody = opts.data;
              return _json(200, _refreshOk);
            }
            // Retry of the original request routes through _refreshDio.
            return _json(200, {'data': 'ok'});
          });

        final mainDio =
            buildApiClient(
                baseUrl: _baseUrl,
                tokenStore: store,
                onSignOut: () async => signOutCalls.add('signOut'),
                enableLogging: false,
                refreshDio: refreshDio,
              )
              ..httpClientAdapter = _FakeAdapter(
                // Original request always returns 401 to trigger refresh.
                (_) => _json(401, {'error': 'expired'}),
              );

        final response = await mainDio.get<dynamic>('/v1/drivers/me');

        // Key behaviours: successful response, new JWT persisted, no sign-out.
        expect(response.statusCode, 200);
        expect(signOutCalls, isEmpty);
        expect(refreshBody, {'refresh_token': 'old-refresh'});
        expect(await store.getJwt(), _refreshOk['access_token']);
        expect(await store.getRefresh(), _refreshOk['refresh_token']);
      },
    );
  });

  group('JwtRefreshInterceptor — 401 → refresh failure → signOut', () {
    test(
      'refresh returns 401: calls onSignOut and surfaces original error',
      () async {
        final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'old-refresh');
        final signOutCalls = <String>[];

        final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
          ..httpClientAdapter = _FakeAdapter(
            (_) => _json(401, {'error': 'refresh_expired'}),
          );

        final mainDio =
            buildApiClient(
                baseUrl: _baseUrl,
                tokenStore: store,
                onSignOut: () async => signOutCalls.add('signOut'),
                enableLogging: false,
                refreshDio: refreshDio,
              )
              ..httpClientAdapter = _FakeAdapter(
                (_) => _json(401, {'error': 'unauthorized'}),
              );

        await expectLater(
          mainDio.get<dynamic>('/v1/drivers/me'),
          throwsA(isA<DioException>()),
        );
        expect(signOutCalls, ['signOut']);
      },
    );

    test('no refresh token stored: calls onSignOut immediately', () async {
      final store = _FakeTokenStore(jwt: 'old.jwt'); // no refresh token
      final signOutCalls = <String>[];

      final mainDio =
          buildApiClient(
              baseUrl: _baseUrl,
              tokenStore: store,
              onSignOut: () async => signOutCalls.add('signOut'),
              enableLogging: false,
              refreshDio: Dio(BaseOptions(baseUrl: _baseUrl))
                ..httpClientAdapter = _FakeAdapter((_) => _json(200, {})),
            )
            ..httpClientAdapter = _FakeAdapter(
              (_) => _json(401, {'error': 'unauthorized'}),
            );

      await expectLater(
        mainDio.get<dynamic>('/v1/drivers/me'),
        throwsA(isA<DioException>()),
      );
      expect(signOutCalls, ['signOut']);
    });
  });

  group('JwtRefreshInterceptor — single-flight', () {
    test('concurrent 401s share one refresh and each retry succeeds', () async {
      final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'refresh-one');
      var refreshCalls = 0;
      final gate = Completer<void>();
      final retried = <String?>[];

      final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
        ..httpClientAdapter = _AsyncAdapter((opts) async {
          if (opts.path == _refreshPath) {
            refreshCalls++;
            await gate.future; // keep the flight open so 401s overlap
            return _json(200, _refreshOk);
          }
          retried.add(opts.headers['Authorization'] as String?);
          return _json(200, {'ok': true});
        });

      final mainDio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async {},
        refreshDio: refreshDio,
      )..httpClientAdapter = _FakeAdapter((_) => _json(401, {'e': 'x'}));

      Future<void>.delayed(const Duration(milliseconds: 20), gate.complete);

      final results = await Future.wait([
        mainDio.get<dynamic>('/v1/a'),
        mainDio.get<dynamic>('/v1/b'),
        mainDio.get<dynamic>('/v1/c'),
      ]);

      expect(results.map((r) => r.statusCode), [200, 200, 200]);
      expect(refreshCalls, 1, reason: 'refresh token is single-use');
      expect(retried, everyElement('Bearer ${_refreshOk['access_token']}'));
      expect(retried, hasLength(3));
      expect(await store.getRefresh(), _refreshOk['refresh_token']);
    });

    test('each request is retried at most once', () async {
      final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'refresh-one');
      var retries = 0;
      final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
        ..httpClientAdapter = _FakeAdapter((opts) {
          if (opts.path == _refreshPath) return _json(200, _refreshOk);
          retries++;
          return _json(401, {'e': 'still'});
        });
      final mainDio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async {},
        refreshDio: refreshDio,
      )..httpClientAdapter = _FakeAdapter((_) => _json(401, {'e': 'x'}));

      await expectLater(
        mainDio.get<dynamic>('/v1/a'),
        throwsA(isA<DioException>()),
      );
      expect(retries, 1);
    });

    test('malformed refresh body signs out', () async {
      final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'refresh-one');
      var signOuts = 0;
      final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
        // Legacy shape (rcab_jwt) is no longer accepted.
        ..httpClientAdapter = _FakeAdapter(
          (_) => _json(200, {'rcab_jwt': 'x', 'refresh_token': 'y'}),
        );
      final mainDio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async => signOuts++,
        refreshDio: refreshDio,
      )..httpClientAdapter = _FakeAdapter((_) => _json(401, {'e': 'x'}));

      await expectLater(
        mainDio.get<dynamic>('/v1/a'),
        throwsA(isA<DioException>()),
      );
      expect(signOuts, 1);
    });

    test('network failure on refresh keeps the session', () async {
      final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'refresh-one');
      var signOuts = 0;
      final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
        ..httpClientAdapter = _ThrowingAdapter();
      final mainDio = buildApiClient(
        baseUrl: _baseUrl,
        tokenStore: store,
        onSignOut: () async => signOuts++,
        refreshDio: refreshDio,
      )..httpClientAdapter = _FakeAdapter((_) => _json(401, {'e': 'x'}));

      await expectLater(
        mainDio.get<dynamic>('/v1/a'),
        throwsA(isA<DioException>()),
      );
      expect(signOuts, 0);
      expect(await store.getRefresh(), 'refresh-one');
    });

    test(
      'sign-out during refresh is not undone by the late response',
      () async {
        final store = _FakeTokenStore(jwt: 'old.jwt', refresh: 'refresh-one');
        final gate = Completer<void>();
        final refreshDio = Dio(BaseOptions(baseUrl: _baseUrl))
          ..httpClientAdapter = _GatedAdapter(gate.future, _refreshOk);
        final mainDio = buildApiClient(
          baseUrl: _baseUrl,
          tokenStore: store,
          onSignOut: () async {},
          refreshDio: refreshDio,
        )..httpClientAdapter = _FakeAdapter((_) => _json(401, {'e': 'x'}));

        final pending = mainDio.get<dynamic>('/v1/a');
        await Future<void>.delayed(const Duration(milliseconds: 10));
        await store.clear(); // user signs out while refresh is in flight
        gate.complete();

        await expectLater(pending, throwsA(isA<DioException>()));
        expect(await store.getJwt(), isNull);
        expect(await store.getRefresh(), isNull);
      },
    );
  });
}
