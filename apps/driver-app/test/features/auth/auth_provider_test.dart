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

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

class MockDio extends Mock implements Dio {}

class _FakeTokenStore extends TokenStore {
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
      requestOptions: RequestOptions(path: '/v1/auth/firebase-exchange'),
    );

DioException _dioError(int statusCode) => DioException(
      requestOptions: RequestOptions(path: '/v1/auth/firebase-exchange'),
      response: Response(
        statusCode: statusCode,
        requestOptions: RequestOptions(path: '/v1/auth/firebase-exchange'),
      ),
      type: DioExceptionType.badResponse,
    );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  setUpAll(() {
    registerFallbackValue(RequestOptions(path: ''));
  });

  group('signInWithFirebaseToken', () {
    test('successful exchange → authenticated state + tokens saved', () async {
      final store = _FakeTokenStore();
      final mockDio = MockDio();
      final notifier = _makeNotifier(store: store, dio: mockDio);

      when(
        () => mockDio.post<Map<String, dynamic>>(
          any(),
          data: any(named: 'data'),
        ),
      ).thenAnswer(
        (_) async => _successResponse({
          'rcab_jwt': 'jwt.payload.sig',
          'refresh_token': 'refresh_abc',
          'user': {'id': 'u1', 'role': 'driver'},
        }),
      );

      expect(notifier.state, isA<AuthStateUnauthenticated>());
      final error = await notifier.signInWithFirebaseToken('fake_id_token');

      expect(error, isNull);
      expect(notifier.state, isA<AuthStateAuthenticated>());
      final authenticated = notifier.state as AuthStateAuthenticated;
      expect(authenticated.userId, 'u1');
      expect(authenticated.role, 'driver');
      expect(await store.getJwt(), 'jwt.payload.sig');
      expect(await store.getRefresh(), 'refresh_abc');
    });

    test('exchange returns 401 → state stays unauthenticated + error returned', () async {
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
    });

    test('network error → state stays unauthenticated + error returned', () async {
      final mockDio = MockDio();
      final notifier = _makeNotifier(dio: mockDio);

      when(
        () => mockDio.post<Map<String, dynamic>>(
          any(),
          data: any(named: 'data'),
        ),
      ).thenThrow(DioException(
        requestOptions: RequestOptions(path: '/v1/auth/firebase-exchange'),
        type: DioExceptionType.connectionError,
      ));

      final error = await notifier.signInWithFirebaseToken('token');

      expect(error, 'Network error');
      expect(notifier.state, isA<AuthStateUnauthenticated>());
    });
  });

  group('signOut', () {
    test('clears tokens, calls firebase signOut, transitions to unauthenticated', () async {
      final store = _FakeTokenStore();
      final mockFb = MockFirebaseAuth();
      final notifier = _makeNotifier(store: store, firebaseAuth: mockFb);
      notifier.state = const AuthStateAuthenticated(userId: 'u1');

      when(() => mockFb.signOut()).thenAnswer((_) async {});
      await store.saveTokens(jwt: 'stored_jwt', refresh: 'stored_refresh');

      await notifier.signOut();

      verify(() => mockFb.signOut()).called(1);
      expect(notifier.state, isA<AuthStateUnauthenticated>());
      expect(await store.getJwt(), isNull);
    });
  });

  group('initialState', () {
    test('notifier with initialState starts authenticated', () {
      final notifier = AuthNotifier(
        _FakeTokenStore(),
        MockFirebaseAuth(),
        MockDio(),
        initialState: const AuthStateAuthenticated(userId: 'u42', role: 'driver'),
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
