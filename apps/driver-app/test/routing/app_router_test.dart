import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/app.dart';
import 'package:driver_app/core/auth/auth_config.dart';
import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/auth/sign_in_screen.dart';
import 'package:driver_app/features/home/home_screen.dart';
import 'package:driver_app/features/offer/offer_screen.dart';
import 'package:driver_app/features/ride/ride_screen.dart';
import 'package:driver_app/features/ride/ride_provider.dart';
import 'package:driver_app/features/ride/ride_models.dart';
import 'package:driver_app/features/rating/rating_screen.dart';
import 'package:driver_app/features/rating/rating_provider.dart';
import 'package:driver_app/features/earnings/earnings_screen.dart';
import 'package:driver_app/features/profile/profile_screen.dart';

// ---------------------------------------------------------------------------
// Fakes & mocks
// ---------------------------------------------------------------------------

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

class MockGoogleSignIn extends Mock implements GoogleSignIn {}

/// In-memory [TokenStore] — overrides every method so the underlying
/// [FlutterSecureStorage] is never called (no platform channels in tests).
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
  Future<void> saveAccount({String? email, String? phoneE164}) async {}

  @override
  Future<String?> getJwt() async => _data['rcab_jwt'];

  @override
  Future<String?> getRefresh() async => _data['rcab_refresh_token'];

  @override
  Future<void> clear() async => _data.clear();
}

/// Returns a fixed ride so [RideScreen]'s mount-time `load()` resolves without
/// a real Dio (otherwise the loading spinner never lets `pumpAndSettle` finish).
class _FakeRideService implements RideService {
  @override
  Future<RideDetail> getRide(String rideId) async => RideDetail(
        rideId: rideId,
        status: 'accepted',
        originLat: 26.14,
        originLng: 91.73,
        destLat: 26.18,
        destLng: 91.75,
      );

  @override
  Future<String> advance(String rideId, String event) async => 'accepted';

  @override
  Future<String> cancel(String rideId, {String? reason}) async => 'cancelled';

  @override
  Future<String> reportNoShow(String rideId) async => 'no_show';
}

/// No-op rating service so [RatingScreen] builds without a real Dio.
class _FakeRatingService implements RatingService {
  @override
  Future<void> submit(String rideId, int stars, String? text) async {}
}

/// Dio whose refresh endpoint answers with a session of the given [role].
class _RefreshDio extends Fake implements Dio {
  _RefreshDio(this.role);
  final String role;

  @override
  Future<Response<T>> post<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    return Response<T>(
      data: {
        'access_token': 'a2',
        'token_type': 'bearer',
        'expires_in': 900,
        'refresh_token': 'r2',
        'user': {'id': 'u1', 'role': role, 'phone_e164': null, 'email': null},
      } as T,
      statusCode: 200,
      requestOptions: RequestOptions(path: path),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Pumps [DriverApp] with a preset [AuthState].
Future<void> _pumpApp(
  WidgetTester tester, {
  AuthState initialState = const AuthStateUnauthenticated(),
}) async {
  final store = _FakeTokenStore();
  final mockFb = MockFirebaseAuth();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tokenStoreProvider.overrideWithValue(store),
        firebaseAuthProvider.overrideWithValue(mockFb),
        authConfigProvider.overrideWith(
          (ref) async => const AuthConfig(methods: {'google'}),
        ),
        authProvider.overrideWith(
          (ref) => AuthNotifier(store, mockFb, Dio())..state = initialState,
        ),
      ],
      child: const DriverApp(),
    ),
  );
  await tester.pumpAndSettle();
}

/// Pumps an isolated [GoRouter] with a single [route] as the initial location.
/// Used to verify each stub screen renders independently of the auth guard.
Future<void> _pumpRoute(
  WidgetTester tester,
  String route,
  Widget screen, {
  List<Override> extraOverrides = const [],
}) async {
  final store = _FakeTokenStore();
  final mockFb = MockFirebaseAuth();
  final router = GoRouter(
    initialLocation: route,
    routes: [GoRoute(path: route, builder: (_, __) => screen)],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        tokenStoreProvider.overrideWithValue(store),
        firebaseAuthProvider.overrideWithValue(mockFb),
        authConfigProvider.overrideWith(
          (ref) async => const AuthConfig(methods: {'google'}),
        ),
        authProvider.overrideWith(
          (ref) => AuthNotifier(store, mockFb, Dio()),
        ),
        ...extraOverrides,
      ],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  group('Auth guard', () {
    testWidgets('unauthenticated cold launch shows /sign-in', (tester) async {
      await _pumpApp(tester);
      expect(find.byKey(const Key('sign_in_screen')), findsOneWidget);
    });

    testWidgets('authenticated cold launch shows /home', (tester) async {
      await _pumpApp(
        tester,
        initialState: const AuthStateAuthenticated(userId: 'u1'),
      );
      expect(find.byKey(const Key('home_screen')), findsOneWidget);
    });

    testWidgets('non-driver role is parked on /not-a-driver', (tester) async {
      await _pumpApp(
        tester,
        initialState: const AuthStateAuthenticated(
          userId: 'u1',
          role: 'client',
          email: 'me@example.com',
        ),
      );
      expect(find.byKey(const Key('not_a_driver_screen')), findsOneWidget);
      expect(find.byKey(const Key('home_screen')), findsNothing);
      expect(find.text('Signed in as me@example.com'), findsOneWidget);
    });

    testWidgets('Retry moves on to /home once the role is driver',
        (tester) async {
      final store = _FakeTokenStore();
      await store.saveTokens(jwt: 'a1', refresh: 'r1');
      final mockFb = MockFirebaseAuth();
      final dio = _RefreshDio('driver');
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            tokenStoreProvider.overrideWithValue(store),
            firebaseAuthProvider.overrideWithValue(mockFb),
            authConfigProvider.overrideWith(
              (ref) async => const AuthConfig(methods: {'google'}),
            ),
            authProvider.overrideWith(
              (ref) => AuthNotifier(store, mockFb, dio)
                ..state = const AuthStateAuthenticated(
                    userId: 'u1', role: 'client', email: 'me@example.com'),
            ),
          ],
          child: const DriverApp(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('not_a_driver_screen')), findsOneWidget);

      await tester.tap(find.byKey(const Key('not_a_driver_retry')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('home_screen')), findsOneWidget);
    });

    testWidgets('Retry while still a client explains and stays',
        (tester) async {
      final store = _FakeTokenStore();
      await store.saveTokens(jwt: 'a1', refresh: 'r1');
      final mockFb = MockFirebaseAuth();
      final dio = _RefreshDio('client');
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            tokenStoreProvider.overrideWithValue(store),
            firebaseAuthProvider.overrideWithValue(mockFb),
            authConfigProvider.overrideWith(
              (ref) async => const AuthConfig(methods: {'google'}),
            ),
            authProvider.overrideWith(
              (ref) => AuthNotifier(store, mockFb, dio)
                ..state = const AuthStateAuthenticated(
                    userId: 'u1', role: 'client'),
            ),
          ],
          child: const DriverApp(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('not_a_driver_retry')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('not_a_driver_screen')), findsOneWidget);
      expect(find.byKey(const Key('not_a_driver_message')), findsOneWidget);
    });

    testWidgets('Sign out from /not-a-driver returns to /sign-in',
        (tester) async {
      final store = _FakeTokenStore();
      final mockFb = MockFirebaseAuth();
      when(() => mockFb.signOut()).thenAnswer((_) async {});
      final google = MockGoogleSignIn();
      when(() => google.signOut()).thenAnswer((_) async => null);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            tokenStoreProvider.overrideWithValue(store),
            firebaseAuthProvider.overrideWithValue(mockFb),
            authConfigProvider.overrideWith(
              (ref) async => const AuthConfig(methods: {'google'}),
            ),
            authProvider.overrideWith(
              (ref) => AuthNotifier(store, mockFb, Dio(),
                  googleSignInFactory: (_) => google)
                ..state = const AuthStateAuthenticated(
                    userId: 'u1', role: 'client'),
            ),
          ],
          child: const DriverApp(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('not_a_driver_sign_out')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('sign_in_screen')), findsOneWidget);
    });

    testWidgets('sign-out from /home redirects to /sign-in', (tester) async {
      final store = _FakeTokenStore();
      final mockFb = MockFirebaseAuth();
      when(() => mockFb.signOut()).thenAnswer((_) async {});
      // The real GoogleSignIn talks to a platform channel that never answers
      // inside a widget test.
      final google = MockGoogleSignIn();
      when(() => google.signOut()).thenAnswer((_) async => null);
      late AuthNotifier notifier;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            tokenStoreProvider.overrideWithValue(store),
            firebaseAuthProvider.overrideWithValue(mockFb),
            authConfigProvider.overrideWith(
              (ref) async => const AuthConfig(methods: {'google'}),
            ),
            authProvider.overrideWith((ref) {
              notifier = AuthNotifier(
                store,
                mockFb,
                Dio(),
                googleSignInFactory: (_) => google,
              )..state = const AuthStateAuthenticated(userId: 'u1');
              return notifier;
            }),
          ],
          child: const DriverApp(),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('home_screen')), findsOneWidget);

      await notifier.signOut();
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('sign_in_screen')), findsOneWidget);
    });
  });

  group('Stub screens render without crashing', () {
    testWidgets('/sign-in', (tester) async {
      await _pumpRoute(tester, '/sign-in', const SignInScreen());
      expect(find.byKey(const Key('sign_in_screen')), findsOneWidget);
    });

    testWidgets('/home', (tester) async {
      await _pumpRoute(tester, '/home', const HomeScreen());
      expect(find.byKey(const Key('home_screen')), findsOneWidget);
    });

    testWidgets('/offer/:id', (tester) async {
      await _pumpRoute(
        tester,
        '/offer/test-id',
        const OfferScreen(offerId: 'test-id'),
      );
      expect(find.byKey(const Key('offer_screen')), findsOneWidget);
    });

    testWidgets('/ride/:id', (tester) async {
      await _pumpRoute(
        tester,
        '/ride/test-id',
        const RideScreen(rideId: 'test-id'),
        extraOverrides: [rideServiceProvider.overrideWithValue(_FakeRideService())],
      );
      expect(find.byKey(const Key('ride_screen')), findsOneWidget);
    });

    testWidgets('/rating/:id', (tester) async {
      await _pumpRoute(
        tester,
        '/rating/test-id',
        const RatingScreen(rideId: 'test-id'),
        extraOverrides: [ratingServiceProvider.overrideWithValue(_FakeRatingService())],
      );
      expect(find.byKey(const Key('rating_screen')), findsOneWidget);
    });

    testWidgets('/earnings', (tester) async {
      await _pumpRoute(tester, '/earnings', const EarningsScreen());
      expect(find.byKey(const Key('earnings_screen')), findsOneWidget);
    });

    testWidgets('/profile', (tester) async {
      await _pumpRoute(tester, '/profile', const ProfileScreen());
      expect(find.byKey(const Key('profile_screen')), findsOneWidget);
    });
  });
}
