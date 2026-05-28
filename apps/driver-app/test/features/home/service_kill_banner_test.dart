import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_app/features/home/service_kill_banner.dart';

Widget _app() => const MaterialApp(
      home: Scaffold(
        body: Column(
          children: [ServiceKillBanner()],
        ),
      ),
    );

void main() {
  testWidgets('banner is visible when last_service_kill_at is within 24 h', (tester) async {
    final killAt = DateTime.now().millisecondsSinceEpoch - const Duration(hours: 1).inMilliseconds;
    SharedPreferences.setMockInitialValues({ServiceKillBanner.prefKey: killAt});

    await tester.pumpWidget(_app());
    await tester.pump(); // let initState async load complete
    await tester.pump();

    expect(find.byKey(const Key('service_kill_banner')), findsOneWidget);
    expect(find.byKey(const Key('service_kill_banner_text')), findsOneWidget);
  });

  testWidgets('banner is absent when last_service_kill_at is older than 24 h', (tester) async {
    final killAt = DateTime.now().millisecondsSinceEpoch - const Duration(hours: 25).inMilliseconds;
    SharedPreferences.setMockInitialValues({ServiceKillBanner.prefKey: killAt});

    await tester.pumpWidget(_app());
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('service_kill_banner')), findsNothing);
  });

  testWidgets('banner is absent when last_service_kill_at is not set', (tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(_app());
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('service_kill_banner')), findsNothing);
  });
}
