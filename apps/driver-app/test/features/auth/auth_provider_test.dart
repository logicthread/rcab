import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';

// ---------------------------------------------------------------------------
// Fakes & mocks
// ---------------------------------------------------------------------------

final Map<String, dynamic> _contract = jsonDecode(
  File('test/fixtures/native_auth_contract.json').readAsStringSync(),
) as Map<String, dynamic>;
Map<String, dynamic> get _exchange =>
    _contract['firebase_exchange'] as Map<String, dynamic>;
Map<String, dynamic> get _google => _contract['google'] as Map<String, dynamic>;
Map<String, dynamic> get _logout => _contract['logout'] as Map<String, dynamic>;

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

class MockDio extends Mock implements Dio {}

class MockGoogleSignIn extends Mock implements GoogleSignIn {}

class MockGoogleSignInAccount extends Mock implements GoogleSignInAccount {}

class MockGoogleSignInAuthentication extends Mock
    implements GoogleSignInAuthentication {}

class _FakeTokenStore extends TokenStore {
  final Map<String, String> _data = {};
  ({String? email, String? phoneE164}) account = (email: null, phoneE164: null);

  @override
  Future<void> saveTokens({
    required String jwt,
    required String refresh,
  }) async {
    _data['rcab_jwt'] = jwt;
    _data['rcab_refresh_token'] = refresh;
  }

  @override
  Future<void> saveAccount({String? email, String? phoneE164}) async {
    account = (email: email, phoneE164: phoneE164);
  }

  @override
  Future<({String? email, String? phoneE164})> getAccount() async => account;

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
        requestOptions:
            RequestOptions(path: '/v1/auth/native/firebase-exchange'),
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

      final captured = verify(
        () => mockDio.post<dynamic>(
          _logout['path'] as String,
          data: req,
          options: captureAny(named: 'options'),
        ),
      ).captured.single as Options;
      // Possession-based logout: the contract lists no required headers and
      // the client sends no Bearer token (an expired one must not block it).
      expect(_logout['headers'] as Map<String, dynamic>, isEmpty);
      expect(captured.headers ?? const {}, isNot(contains('Authorization')));
      verify(() => mockFb.signOut()).called(1);
      expect(notifier.state, isA<AuthStateUnauthenticated>());
      expect(await store.getJwt(), isNull);
      expect(await store.getRefresh(), isNull);
    });

    test(
      'no access token stored (expired/idle): still revokes via refresh token',
      () async {
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
            statusCode: 204,
            requestOptions: RequestOptions(path: _logout['path'] as String),
          ),
        );
        // Only the refresh token survives (e.g. the JWT slot was wiped).
        await store.saveTokens(jwt: 'unused', refresh: 'refresh-only');
        store._data.remove('rcab_jwt');

        await notifier.signOut();

        verify(
          () => mockDio.post<dynamic>(
            _logout['path'] as String,
            data: {'refresh_token': 'refresh-only'},
            options: any(named: 'options'),
          ),
        ).called(1);
        expect(await store.getRefresh(), isNull);
        expect(notifier.state, isA<AuthStateUnauthenticated>());
      },
    );

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

  // RCAB-E8.S15: Google is the only login method until launch.
  group('signInWithGoogle', () {
    late _FakeTokenStore store;
    late MockDio dio;
    late MockGoogleSignIn gs;
    late MockGoogleSignInAccount account;
    late MockGoogleSignInAuthentication gAuth;
    String? factoryClientId;
    late AuthNotifier notifier;

    setUp(() {
      store = _FakeTokenStore();
      dio = MockDio();
      gs = MockGoogleSignIn();
      account = MockGoogleSignInAccount();
      gAuth = MockGoogleSignInAuthentication();
      factoryClientId = null;
      when(() => gs.signOut()).thenAnswer((_) async => null);
      when(() => account.authentication).thenAnswer((_) async => gAuth);
      when(() => gAuth.idToken)
          .thenReturn((_google['request'] as Map)['id_token'] as String);
      notifier = AuthNotifier(
        store,
        MockFirebaseAuth(),
        dio,
        googleSignInFactory: (id) {
          factoryClientId = id;
          return gs;
        },
      );
    });

    test('contract: posts the Google ID token, parses the native session',
        () async {
      when(() => gs.signIn()).thenAnswer((_) async => account);
      when(() =>
          dio.post<Map<String, dynamic>>(any(),
              data: any(named: 'data'))).thenAnswer((_) async =>
          _successResponse(_google['response_200'] as Map<String, dynamic>));

      final error = await notifier.signInWithGoogle(
        serverClientId: 'web-client.apps.test',
      );

      expect(error, isNull);
      expect(factoryClientId, 'web-client.apps.test');
      verify(() => dio.post<Map<String, dynamic>>(
            _google['path'] as String,
            data: _google['request'],
          )).called(1);
      final ok = _google['response_200'] as Map<String, dynamic>;
      final user = ok['user'] as Map<String, dynamic>;
      final state = notifier.state as AuthStateAuthenticated;
      expect(state.userId, user['id']);
      expect(state.role, user['role']);
      // A Google account has no phone: the email is the account label.
      expect(user['phone_e164'], isNull);
      expect(state.phoneE164, isNull);
      expect(state.email, user['email']);
      expect(state.accountLabel, user['email']);
      expect(await store.getJwt(), ok['access_token']);
      expect(await store.getRefresh(), ok['refresh_token']);
      expect(store.account.email, user['email']);
    });

    test('user dismisses the picker: no error, stays signed out', () async {
      when(() => gs.signIn()).thenAnswer((_) async => null);

      expect(await notifier.signInWithGoogle(), isNull);
      expect(notifier.state, isA<AuthStateUnauthenticated>());
      verifyNever(() =>
          dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')));
    });

    test('picker throws (e.g. no Play Services): clear error', () async {
      when(() => gs.signIn()).thenThrow(Exception('network_error'));

      final error = await notifier.signInWithGoogle();

      expect(error, contains('Google sign-in failed'));
      expect(notifier.state, isA<AuthStateUnauthenticated>());
    });

    test('no ID token (OAuth client not set up): clear error, no API call',
        () async {
      when(() => gs.signIn()).thenAnswer((_) async => account);
      when(() => gAuth.idToken).thenReturn(null);

      final error = await notifier.signInWithGoogle();

      expect(error, contains('not set up'));
      verifyNever(() =>
          dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')));
    });

    test('API 403 google_email_unverified keeps the user signed out', () async {
      when(() => gs.signIn()).thenAnswer((_) async => account);
      when(() =>
              dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')))
          .thenThrow(DioException(
        requestOptions: RequestOptions(path: ''),
        type: DioExceptionType.badResponse,
        response: Response(
          statusCode: 403,
          data: {
            'error': {'code': 'google_email_unverified', 'message': 'x'},
          },
          requestOptions: RequestOptions(path: ''),
        ),
      ));

      final error = await notifier.signInWithGoogle();

      expect(error, contains('not verified'));
      expect(notifier.state, isA<AuthStateUnauthenticated>());
      expect(await store.getJwt(), isNull);
    });

    test('offline: Network error', () async {
      when(() => gs.signIn()).thenAnswer((_) async => account);
      when(() =>
              dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')))
          .thenThrow(DioException(
        requestOptions: RequestOptions(path: ''),
        type: DioExceptionType.connectionError,
      ));

      expect(await notifier.signInWithGoogle(), 'Network error');
    });

    test('signOut also signs out of Google (next sign-in re-prompts)',
        () async {
      when(() => gs.signIn()).thenAnswer((_) async => account);
      when(() =>
          dio.post<Map<String, dynamic>>(any(),
              data: any(named: 'data'))).thenAnswer((_) async =>
          _successResponse(_google['response_200'] as Map<String, dynamic>));
      when(() => dio.post<dynamic>(
            any(),
            data: any(named: 'data'),
            options: any(named: 'options'),
          )).thenAnswer((_) async => Response<dynamic>(
            statusCode: 204,
            requestOptions: RequestOptions(path: ''),
          ));
      await notifier.signInWithGoogle();

      await notifier.signOut();

      verify(() => gs.signOut()).called(1);
      expect(notifier.state, isA<AuthStateUnauthenticated>());
      expect(await store.getRefresh(), isNull);
    });

    test('a failing Google signOut cannot block sign-out', () async {
      when(() => gs.signOut()).thenThrow(Exception('boom'));
      notifier.state = const AuthStateAuthenticated(userId: 'u1');

      await notifier.signOut();

      expect(notifier.state, isA<AuthStateUnauthenticated>());
    });
  });

  group('restore session', () {
    test('cold start restores the stored account label', () async {
      final store = _FakeTokenStore();
      // JWT payload {"sub":"u9","role":"driver"}
      const payload = 'eyJzdWIiOiJ1OSIsInJvbGUiOiJkcml2ZXIifQ';
      await store.saveTokens(jwt: 'h.$payload.s', refresh: 'r');
      store.account = (email: 'me@example.com', phoneE164: null);

      final notifier = AuthNotifier(store, MockFirebaseAuth(), MockDio());
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);

      final state = notifier.state as AuthStateAuthenticated;
      expect(state.userId, 'u9');
      expect(state.email, 'me@example.com');
    });
  });

  group('refreshSession', () {
    Map<String, dynamic> body(String role) => {
          'access_token': 'a2',
          'token_type': 'bearer',
          'expires_in': 900,
          'refresh_token': 'r2',
          'user': {
            'id': 'u1',
            'role': role,
            'phone_e164': null,
            'email': 'me@example.com',
          },
        };

    test('picks up a role change and rotates the tokens', () async {
      final store = _FakeTokenStore();
      await store.saveTokens(jwt: 'a1', refresh: 'r1');
      final dio = MockDio();
      when(() => dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')))
          .thenAnswer((_) async => _successResponse(body('driver')));
      final notifier = AuthNotifier(
        store,
        MockFirebaseAuth(),
        dio,
        initialState: const AuthStateAuthenticated(
          userId: 'u1',
          role: 'client',
          email: 'me@example.com',
        ),
      );

      expect(await notifier.refreshSession(), isNull);

      final state = notifier.state as AuthStateAuthenticated;
      expect(state.role, 'driver');
      expect(state.isDriver, isTrue);
      expect(await store.getRefresh(), 'r2');
      verify(() => dio.post<Map<String, dynamic>>(
            '/v1/auth/native/refresh',
            data: {'refresh_token': 'r1'},
          )).called(1);
    });

    test('network failure keeps the session and returns a message', () async {
      final store = _FakeTokenStore();
      await store.saveTokens(jwt: 'a1', refresh: 'r1');
      final dio = MockDio();
      when(() => dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')))
          .thenThrow(DioException(
        requestOptions: RequestOptions(path: ''),
        type: DioExceptionType.connectionError,
      ));
      final notifier = AuthNotifier(
        store,
        MockFirebaseAuth(),
        dio,
        initialState:
            const AuthStateAuthenticated(userId: 'u1', role: 'client'),
      );

      expect(await notifier.refreshSession(), isNotNull);
      expect(notifier.state, isA<AuthStateAuthenticated>());
    });

    test('a rejected refresh (401) signs out', () async {
      final store = _FakeTokenStore();
      await store.saveTokens(jwt: 'a1', refresh: 'r1');
      final dio = MockDio();
      final fb = MockFirebaseAuth();
      when(() => fb.signOut()).thenAnswer((_) async {});
      when(() => dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')))
          .thenThrow(_dioError(401));
      when(() => dio.post<dynamic>(any(),
          data: any(named: 'data'),
          options: any(named: 'options'))).thenAnswer((_) async =>
          Response<dynamic>(
              statusCode: 204, requestOptions: RequestOptions(path: '')));
      final google = MockGoogleSignIn();
      when(() => google.signOut()).thenAnswer((_) async => null);
      final notifier = AuthNotifier(
        store,
        fb,
        dio,
        initialState:
            const AuthStateAuthenticated(userId: 'u1', role: 'client'),
        googleSignInFactory: (_) => google,
      );

      expect(await notifier.refreshSession(), isNull);
      expect(notifier.state, isA<AuthStateUnauthenticated>());
    });
  });
}
