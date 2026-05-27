import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/driver/driver_state.dart';
import '../../di/providers.dart';
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

    if (notifier.currentVehicleId == null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            key: Key('no_vehicle_snackbar'),
            content: Text('Please select a vehicle before going online'),
          ),
        );
      }
      return;
    }

    Position pos;
    try {
      pos = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.high,
      );
    } catch (_) {
      pos = Position.fromMap({
        'latitude': 0.0,
        'longitude': 0.0,
        'timestamp': DateTime.now().millisecondsSinceEpoch,
        'accuracy': 0.0,
        'altitude': 0.0,
        'heading': 0.0,
        'speed': 0.0,
        'speedAccuracy': 0.0,
        'altitudeAccuracy': 0.0,
        'headingAccuracy': 0.0,
      });
    }

    final error = await notifier.goOnline(lat: pos.latitude, lng: pos.longitude);
    if (error != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error)),
      );
      return;
    }

    // Show OEM battery-whitelist onboarding on first ever online toggle.
    if (mounted) await showOemOnboardingIfNeeded(context);
  }

  @override
  Widget build(BuildContext context) {
    final driverState = ref.watch(driverStateProvider);
    final isOnline = driverState is DriverOnline;

    return Scaffold(
      key: const Key('home_screen'),
      appBar: AppBar(title: const Text('rcab')),
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
