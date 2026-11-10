import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../di/providers.dart';
import '../core/auth/auth_state.dart';
import '../features/auth/not_a_driver_screen.dart';
import '../features/auth/sign_in_screen.dart';
import '../features/home/home_screen.dart';
import '../features/offer/offer_screen.dart';
import '../features/ride/ride_screen.dart';
import '../features/shared_ride/shared_ride_screen.dart';
import '../features/rating/rating_screen.dart';
import '../features/earnings/earnings_screen.dart';
import '../features/profile/profile_screen.dart';
import '../features/profile/vehicle_form_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  final refreshNotifier = _RouterRefreshNotifier(ref);

  return GoRouter(
    initialLocation: '/sign-in',
    refreshListenable: refreshNotifier,
    redirect: (context, state) {
      final auth = ref.read(authProvider);
      final isAuthenticated = auth is AuthStateAuthenticated;
      final isOnSignIn = state.matchedLocation == '/sign-in';
      final isOnNotDriver = state.matchedLocation == '/not-a-driver';

      if (!isAuthenticated) return isOnSignIn ? null : '/sign-in';
      // Signed in but not (yet) a driver: every driver endpoint would be
      // refused, so park the user on an explanatory screen.
      if (!auth.isDriver) return isOnNotDriver ? null : '/not-a-driver';
      if (isOnSignIn || isOnNotDriver) return '/home';
      return null;
    },
    routes: [
      GoRoute(
        path: '/sign-in',
        builder: (_, __) => const SignInScreen(),
      ),
      GoRoute(
        path: '/not-a-driver',
        builder: (_, __) => const NotADriverScreen(),
      ),
      GoRoute(
        path: '/home',
        builder: (_, __) => const HomeScreen(),
      ),
      GoRoute(
        path: '/offer/:id',
        builder: (_, state) =>
            OfferScreen(offerId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/ride/:id',
        builder: (_, state) =>
            RideScreen(rideId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/shared-ride/:id',
        builder: (_, state) =>
            SharedRideScreen(rideId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/rating/:id',
        builder: (_, state) =>
            RatingScreen(rideId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '/earnings',
        builder: (_, __) => const EarningsScreen(),
      ),
      GoRoute(
        path: '/profile',
        builder: (_, __) => const ProfileScreen(),
        routes: [
          GoRoute(
            path: 'vehicle/add',
            builder: (_, __) => const VehicleFormScreen(),
          ),
        ],
      ),
    ],
  );
});

/// Notifies [GoRouter] whenever [authProvider] state changes so the
/// redirect guard re-evaluates without requiring an explicit navigation call.
class _RouterRefreshNotifier extends ChangeNotifier {
  _RouterRefreshNotifier(Ref ref) {
    _sub = ref.listen<AuthState>(
      authProvider,
      (_, __) => notifyListeners(),
    );
  }

  late final ProviderSubscription<AuthState> _sub;

  @override
  void dispose() {
    _sub.close();
    super.dispose();
  }
}
