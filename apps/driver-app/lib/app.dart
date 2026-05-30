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
      if (next is AuthStateAuthenticated && _sharedRideCtrl == null) {
        final router = ref.read(routerProvider);
        _sharedRideCtrl = SharedRideController(
          container: container,
          router: router,
        )..start();
        _offerCtrl = OfferController(
          container: container,
          router: router,
        )..start();
      } else if (next is! AuthStateAuthenticated && _sharedRideCtrl != null) {
        _sharedRideCtrl?.stop();
        _sharedRideCtrl = null;
        _offerCtrl?.stop();
        _offerCtrl = null;
      }
    }, fireImmediately: true);
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
