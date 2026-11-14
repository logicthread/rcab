import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/auth/auth_state.dart';
import 'di/providers.dart';
import 'features/offer/offer_controller.dart';
import 'features/shared_ride/shared_ride_controller.dart';
import 'routing/app_router.dart';

class DriverApp extends ConsumerStatefulWidget {
  const DriverApp({super.key});

  @override
  ConsumerState<DriverApp> createState() => _DriverAppState();
}

class _DriverAppState extends ConsumerState<DriverApp> {
  SharedRideController? _sharedRideCtrl;
  OfferController? _offerCtrl;
  bool _wiredAuthListener = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_wiredAuthListener) return;
    _wiredAuthListener = true;
    final container = ProviderScope.containerOf(context);
    ref.listenManual<AuthState>(authProvider, (prev, next) {
      // The realtime socket authenticates as one user with one role, and the
      // server puts it in `driver:<id>` only for a driver token. So a sign-out,
      // another account, or a role change (an operator enabling this account as
      // a driver, then Retry) must reopen it; otherwise the driver never
      // receives an offer (found walking the driver flows, RCAB-E8.S15).
      final identityChanged = next is AuthStateAuthenticated &&
          (prev is! AuthStateAuthenticated ||
              prev.userId != next.userId ||
              prev.role != next.role ||
              _sharedRideCtrl == null);
      if (next is! AuthStateAuthenticated || identityChanged) {
        _stopRealtime(container);
      }
      if (identityChanged) {
        final router = ref.read(routerProvider);
        _sharedRideCtrl = SharedRideController(
          container: container,
          router: router,
        )..start();
        _offerCtrl = OfferController(
          container: container,
          router: router,
        )..start();
      }
    }, fireImmediately: true);
  }

  void _stopRealtime(ProviderContainer container) {
    if (_sharedRideCtrl == null && _offerCtrl == null) return;
    _sharedRideCtrl?.stop();
    _sharedRideCtrl = null;
    _offerCtrl?.stop();
    _offerCtrl = null;
    container.read(realtimeSocketProvider).disconnect();
  }

  @override
  void dispose() {
    _sharedRideCtrl?.stop();
    _offerCtrl?.stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);
    return MaterialApp.router(
      title: 'rcab Driver',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF1B8EF8), // TODO: brand palette — pending design
          brightness: Brightness.light,
        ),
        useMaterial3: true,
      ),
      routerConfig: router,
    );
  }
}
