import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/app.dart';
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
import 'package:driver_app/features/earnings/earnings_screen.dart';
import 'package:driver_app/features/profile/profile_screen.dart';

// ---------------------------------------------------------------------------
// Fakes & mocks
// ---------------------------------------------------------------------------

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

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

    testWidgets('sign-out from /home redirects to /sign-in', (tester) async {
      final store = _FakeTokenStore();
      final mockFb = MockFirebaseAuth();
      when(() => mockFb.signOut()).thenAnswer((_) async {});
      late AuthNotifier notifier;

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            tokenStoreProvider.overrideWithValue(store),
            firebaseAuthProvider.overrideWithValue(mockFb),
            authProvider.overrideWith((ref) {
              notifier = AuthNotifier(store, mockFb, Dio())
                ..state = const AuthStateAuthenticated(userId: 'u1');
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
