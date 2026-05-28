import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_app/features/home/oem_onboarding_sheet.dart';

// Minimal scaffold to host the sheet trigger.
Widget _app({required Future<void> Function(BuildContext) trigger}) {
  return MaterialApp(
    home: Builder(
      builder: (ctx) => Scaffold(
        body: ElevatedButton(
          key: const Key('trigger'),
          onPressed: () => trigger(ctx),
          child: const Text('go'),
        ),
      ),
    ),
  );
}

void main() {
  // permission_handler needs no real platform in widget tests — it will just
  // return PermissionStatus.denied on the mock platform.
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('sheet appears when oem_onboarding_shown is not set', (tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(_app(trigger: showOemOnboardingIfNeeded));
    await tester.tap(find.byKey(const Key('trigger')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('oem_sheet_title')), findsOneWidget);
    expect(find.byKey(const Key('oem_skip_button')), findsOneWidget);
    expect(find.byKey(const Key('oem_open_settings_button')), findsOneWidget);
  });

  testWidgets('sheet does NOT appear when oem_onboarding_shown is true', (tester) async {
    SharedPreferences.setMockInitialValues({'oem_onboarding_shown': true});

    await tester.pumpWidget(_app(trigger: showOemOnboardingIfNeeded));
    await tester.tap(find.byKey(const Key('trigger')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('oem_sheet_title')), findsNothing);
  });

  testWidgets('Skip button dismisses sheet and sets oem_onboarding_shown=true', (tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(_app(trigger: showOemOnboardingIfNeeded));
    await tester.tap(find.byKey(const Key('trigger')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('oem_sheet_title')), findsOneWidget);

    await tester.tap(find.byKey(const Key('oem_skip_button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('oem_sheet_title')), findsNothing);

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('oem_onboarding_shown'), isTrue);
  });
}
