import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Displays a yellow warning banner when the foreground service was killed
/// by the OS within the last 24 hours.
class ServiceKillBanner extends StatefulWidget {
  const ServiceKillBanner({super.key});

  static const String prefKey = 'last_service_kill_at';
  static const int _windowMs = 86400000; // 24 h

  @override
  State<ServiceKillBanner> createState() => _ServiceKillBannerState();
}

class _ServiceKillBannerState extends State<ServiceKillBanner> {
  bool _show = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final killAt = prefs.getInt(ServiceKillBanner.prefKey);
    if (killAt != null) {
      final age = DateTime.now().millisecondsSinceEpoch - killAt;
      if (mounted) setState(() => _show = age < ServiceKillBanner._windowMs);
    }
  }

  Future<void> _openSettings() async {
    await Permission.ignoreBatteryOptimizations.request();
  }

  @override
  Widget build(BuildContext context) {
    if (!_show) return const SizedBox.shrink();

    return MaterialBanner(
      key: const Key('service_kill_banner'),
      backgroundColor: Colors.amber.shade100,
      content: const Text(
        'Your location service was stopped — please whitelist rcab in battery settings',
        key: Key('service_kill_banner_text'),
      ),
      actions: [
        TextButton(
          key: const Key('service_kill_open_settings'),
          onPressed: _openSettings,
          child: const Text('Open Settings'),
        ),
        TextButton(
          key: const Key('service_kill_dismiss'),
          onPressed: () => setState(() => _show = false),
          child: const Text('Dismiss'),
        ),
      ],
    );
  }
}
