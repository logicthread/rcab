import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _kPrefKey = 'oem_onboarding_shown';

/// Shows the OEM battery-whitelist onboarding bottom sheet the first time
/// the driver goes online. No-ops if already shown or context is gone.
Future<void> showOemOnboardingIfNeeded(BuildContext context) async {
  final prefs = await SharedPreferences.getInstance();
  if (prefs.getBool(_kPrefKey) == true) return;
  if (!context.mounted) return;

  await showModalBottomSheet<void>(
    context: context,
    isDismissible: false,
    enableDrag: false,
    builder: (ctx) => _OemOnboardingSheet(prefs: prefs),
  );
}

class _OemOnboardingSheet extends StatelessWidget {
  const _OemOnboardingSheet({required this.prefs});

  final SharedPreferences prefs;

  Future<void> _markShown() => prefs.setBool(_kPrefKey, true);

  Future<void> _openSettings(BuildContext context) async {
    await _markShown();
    // Triggers ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS system dialog.
    await Permission.ignoreBatteryOptimizations.request();
    if (context.mounted) Navigator.of(context).pop();
  }

  Future<void> _skip(BuildContext context) async {
    await _markShown();
    if (context.mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Keep your location running',
              key: const Key('oem_sheet_title'),
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            const Text(
              'Some Android devices stop background apps to save battery. '
              'To stay online reliably, please add rcab to your battery whitelist.',
              key: Key('oem_sheet_body'),
            ),
            const SizedBox(height: 24),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  key: const Key('oem_skip_button'),
                  onPressed: () => _skip(context),
                  child: const Text('Skip'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: const Key('oem_open_settings_button'),
                  onPressed: () => _openSettings(context),
                  child: const Text('Open Settings'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
