import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';

// ---------------------------------------------------------------------------
// Fakes & mocks
// ---------------------------------------------------------------------------

final Map<String, dynamic> _contract =
    jsonDecode(
          File('test/fixtures/native_auth_contract.json').readAsStringSync(),
        )
        as Map<String, dynamic>;
Map<String, dynamic> get _exchange =>
    _contract['firebase_exchange'] as Map<String, dynamic>;
Map<String, dynamic> get _logout => _contract['logout'] as Map<String, dynamic>;

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

class MockDio extends Mock implements Dio {}

class _FakeTokenStore extends TokenStore {
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

AuthNotifier _makeNotifier({
  _FakeTokenStore? store,
  MockFirebaseAuth? firebaseAuth,
  MockDio? dio,
}) {
  return AuthNotifier(
    store ?? _FakeTokenStore(),
    firebaseAuth ?? MockFirebaseAuth(),
    dio ?? MockDio(),
  );
}

Response<Map<String, dynamic>> _successResponse(Map<String, dynamic> data) =>
    Response<Map<String, dynamic>>(
      data: data,
      statusCode: 200,
      requestOptions: RequestOptions(path: '/v1/auth/native/firebase-exchange'),
    );

DioException _dioError(int statusCode) => DioException(
  requestOptions: RequestOptions(path: '/v1/auth/native/firebase-exchange'),
  response: Response(
    statusCode: statusCode,
    requestOptions: RequestOptions(path: '/v1/auth/native/firebase-exchange'),
  ),
  type: DioExceptionType.badResponse,
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  setUpAll(() {
    registerFallbackValue(RequestOptions(path: ''));
    registerFallbackValue(Options());
  });

  group('signInWithFirebaseToken', () {
    test('successful exchange → authenticated state + tokens saved', () async {
      final store = _FakeTokenStore();
      final mockDio = MockDio();
      final notifier = _makeNotifier(store: store, dio: mockDio);

      when(
        () =>
            mockDio.post<Map<String, dynamic>>(any(), data: any(named: 'data')),
      ).thenAnswer(
        (_) async =>
            _successResponse(_exchange['response_200'] as Map<String, dynamic>),
      );

      expect(notifier.state, isA<AuthStateUnauthenticated>());
      final error = await notifier.signInWithFirebaseToken(
        _exchange['request']['id_token'] as String,
      );

      expect(error, isNull);
      verify(
        () => mockDio.post<Map<String, dynamic>>(
          _exchange['path'] as String,
          data: _exchange['request'],
        ),
      ).called(1);
      expect(notifier.state, isA<AuthStateAuthenticated>());
      final authenticated = notifier.state as AuthStateAuthenticated;
      final ok = _exchange['response_200'] as Map<String, dynamic>;
      final user = ok['user'] as Map<String, dynamic>;
      expect(authenticated.userId, user['id']);
      expect(authenticated.role, user['role']);
      expect(await store.getJwt(), ok['access_token']);
      expect(await store.getRefresh(), ok['refresh_token']);
    });

    test('legacy rcab_jwt response shape is rejected', () async {
      final store = _FakeTokenStore();
      final mockDio = MockDio();
      final notifier = _makeNotifier(store: store, dio: mockDio);
      when(
        () =>
            mockDio.post<Map<String, dynamic>>(any(), data: any(named: 'data')),
      ).thenAnswer(
        (_) async => _successResponse({
          'rcab_jwt': 'jwt',
          'refresh_token': 'r',
          'user': {'id': 'u1', 'role': 'driver'},
        }),
      );

      final error = await notifier.signInWithFirebaseToken('t');

      expect(error, isNotNull);
      expect(notifier.state, isA<AuthStateUnauthenticated>());
      expect(await store.getJwt(), isNull);
    });

    test(
      'exchange returns 401 → state stays unauthenticated + error returned',
      () async {
        final mockDio = MockDio();
        final notifier = _makeNotifier(dio: mockDio);

        when(
          () => mockDio.post<Map<String, dynamic>>(
            any(),
            data: any(named: 'data'),
          ),
        ).thenThrow(_dioError(401));

        final error = await notifier.signInWithFirebaseToken('bad_token');

        expect(error, isNotNull);
        expect(error, contains('401'));
        expect(notifier.state, isA<AuthStateUnauthenticated>());
      },
    );

    test(
      'network error → state stays unauthenticated + error returned',
      () async {
        final mockDio = MockDio();
        final notifier = _makeNotifier(dio: mockDio);

        when(
          () => mockDio.post<Map<String, dynamic>>(
            any(),
            data: any(named: 'data'),
          ),
        ).thenThrow(
          DioException(
            requestOptions: RequestOptions(
              path: '/v1/auth/native/firebase-exchange',
            ),
            type: DioExceptionType.connectionError,
          ),
        );

        final error = await notifier.signInWithFirebaseToken('token');

        expect(error, 'Network error');
        expect(notifier.state, isA<AuthStateUnauthenticated>());
      },
    );
  });

  group('signOut', () {
    test('calls native logout, clears tokens, signs out of firebase', () async {
      final store = _FakeTokenStore();
      final mockFb = MockFirebaseAuth();
      final mockDio = MockDio();
      final notifier = _makeNotifier(
        store: store,
        firebaseAuth: mockFb,
        dio: mockDio,
      );
      notifier.state = const AuthStateAuthenticated(userId: 'u1');

      when(() => mockFb.signOut()).thenAnswer((_) async {});
      when(
        () => mockDio.post<dynamic>(
          any(),
          data: any(named: 'data'),
          options: any(named: 'options'),
        ),
      ).thenAnswer(
        (_) async => Response<dynamic>(
          statusCode: _logout['response_status'] as int,
          requestOptions: RequestOptions(path: _logout['path'] as String),
        ),
      );
      final req = _logout['request'] as Map<String, dynamic>;
      await store.saveTokens(
        jwt: 'access.jwt.one',
        refresh: req['refresh_token'] as String,
      );

      await notifier.signOut();

      final captured =
          verify(
                () => mockDio.post<dynamic>(
                  _logout['path'] as String,
                  data: req,
                  options: captureAny(named: 'options'),
                ),
              ).captured.single
              as Options;
      expect(captured.headers, (_logout['headers'] as Map<String, dynamic>));
      verify(() => mockFb.signOut()).called(1);
      expect(notifier.state, isA<AuthStateUnauthenticated>());
      expect(await store.getJwt(), isNull);
      expect(await store.getRefresh(), isNull);
    });

    test('offline: logout failure still clears local tokens', () async {
      final store = _FakeTokenStore();
      final mockFb = MockFirebaseAuth();
      final mockDio = MockDio();
      final notifier = _makeNotifier(
        store: store,
        firebaseAuth: mockFb,
        dio: mockDio,
      );
      notifier.state = const AuthStateAuthenticated(userId: 'u1');

      when(() => mockFb.signOut()).thenAnswer((_) async {});
      when(
        () => mockDio.post<dynamic>(
          any(),
          data: any(named: 'data'),
          options: any(named: 'options'),
        ),
      ).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: '/v1/auth/native/logout'),
          type: DioExceptionType.connectionError,
        ),
      );
      await store.saveTokens(jwt: 'j', refresh: 'r');

      await notifier.signOut();

      expect(notifier.state, isA<AuthStateUnauthenticated>());
      expect(await store.getJwt(), isNull);
      expect(await store.getRefresh(), isNull);
      verify(() => mockFb.signOut()).called(1);
    });

    test('no stored refresh token: skips logout call, still clears', () async {
      final mockFb = MockFirebaseAuth();
      final mockDio = MockDio();
      final notifier = _makeNotifier(firebaseAuth: mockFb, dio: mockDio);
      when(() => mockFb.signOut()).thenAnswer((_) async {});

      await notifier.signOut();

      verifyNever(
        () => mockDio.post<dynamic>(
          any(),
          data: any(named: 'data'),
          options: any(named: 'options'),
        ),
      );
      expect(notifier.state, isA<AuthStateUnauthenticated>());
    });
  });

  group('initialState', () {
    test('notifier with initialState starts authenticated', () {
      final notifier = AuthNotifier(
        _FakeTokenStore(),
        MockFirebaseAuth(),
        MockDio(),
        initialState: const AuthStateAuthenticated(
          userId: 'u42',
          role: 'driver',
        ),
      );
      expect(notifier.state, isA<AuthStateAuthenticated>());
      final auth = notifier.state as AuthStateAuthenticated;
      expect(auth.userId, 'u42');
    });

    test('notifier without initialState starts unauthenticated', () {
      final notifier = _makeNotifier();
      expect(notifier.state, isA<AuthStateUnauthenticated>());
    });
  });
}
