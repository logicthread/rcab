import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/driver/driver_state.dart';
import '../../core/driver/driver_state_notifier.dart';
import '../../di/providers.dart';
import 'driver_notice.dart';
import 'oem_onboarding_sheet.dart';
import 'service_kill_banner.dart';

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen>
    with WidgetsBindingObserver {
  bool _toggling = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // A notice set before this screen mounted (we were routed here).
    WidgetsBinding.instance.addPostFrameCallback((_) => _showNotice(ref.read(driverNoticeProvider)));
  }

  void _showNotice(String? notice) {
    if (notice == null || !mounted) return;
    ref.read(driverNoticeProvider.notifier).state = null;
    _snack(notice, key: const Key('driver_notice'));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final driverState = ref.read(driverStateProvider);
    if (driverState is! DriverOnline) return;
    _checkServiceHealth();
  }

  Future<void> _checkServiceHealth() async {
    final running = await FlutterForegroundTask.isRunningService;
    if (!running && mounted) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setInt(
        ServiceKillBanner.prefKey,
        DateTime.now().millisecondsSinceEpoch,
      );
      setState(() {});
    }
  }

  Future<void> _toggle(DriverState current) async {
    if (_toggling) return;
    setState(() => _toggling = true);

    try {
      if (current is DriverOffline) {
        await _goOnline();
      } else {
        await ref.read(driverStateProvider.notifier).goOffline();
      }
    } finally {
      if (mounted) setState(() => _toggling = false);
    }
  }

  Future<void> _goOnline() async {
    final notifier = ref.read(driverStateProvider.notifier);

    // Permission + a real fix first: never go online without a position.
    final located = await ref.read(driverLocatorProvider).locate();
    final pos = located.position;
    if (pos == null) {
      _snack(located.error!, key: const Key('location_snackbar'));
      return;
    }

    final error = await notifier.goOnline(lat: pos.latitude, lng: pos.longitude);
    if (error != null) {
      _snack(
        error,
        key: error == DriverStateNotifier.noVehicleMessage ? const Key('no_vehicle_snackbar') : null,
      );
      return;
    }

    // Show OEM battery-whitelist onboarding on first ever online toggle.
    if (mounted) await showOemOnboardingIfNeeded(context);
  }

  void _snack(String message, {Key? key}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(key: key, content: Text(message)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverStateProvider);
    final isOnline = driverState is DriverOnline;
    ref.listen<String?>(driverNoticeProvider, (_, next) => _showNotice(next));

    return Scaffold(
      key: const Key('home_screen'),
      appBar: AppBar(
        title: const Text('rcab'),
        actions: [
          IconButton(
            key: const Key('earnings_button'),
            icon: const Icon(Icons.account_balance_wallet_outlined),
            tooltip: 'Earnings',
            onPressed: () => context.push('/earnings'),
          ),
          IconButton(
            key: const Key('profile_button'),
            icon: const Icon(Icons.person_outline),
            tooltip: 'Profile & vehicles',
            onPressed: () => context.push('/profile'),
          ),
        ],
      ),
      body: Column(
        children: [
          const ServiceKillBanner(),
          Expanded(
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    isOnline ? 'You are online' : 'You are offline',
                    key: const Key('status_label'),
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: 32),
                  _toggling
                      ? const CircularProgressIndicator()
                      : GestureDetector(
                          key: const Key('online_toggle'),
                          onTap: () => _toggle(driverState),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 200),
                            width: 120,
                            height: 120,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: isOnline ? Colors.green : Colors.grey,
                            ),
                            child: Icon(
                              isOnline ? Icons.wifi : Icons.wifi_off,
                              color: Colors.white,
                              size: 48,
                            ),
                          ),
                        ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
