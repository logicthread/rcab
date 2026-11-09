import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/home/driver_notice.dart';
import 'package:driver_app/features/home/home_screen.dart';

// Regression (RCAB-E8.S14): when the app routed the driver home on its own
// (offer lost / expired, passenger cancelled) the screen just vanished.
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('a pending notice is shown once on arrival and cleared', (tester) async {
    final container = ProviderContainer(overrides: [
      apiClientProvider.overrideWithValue(Dio()),
    ]);
    addTearDown(container.dispose);
    container.read(driverNoticeProvider.notifier).state = 'Another driver accepted this ride';

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: HomeScreen()),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byKey(const Key('driver_notice')), findsOneWidget);
    expect(find.text('Another driver accepted this ride'), findsOneWidget);
    expect(container.read(driverNoticeProvider), isNull);
  });

  test('offer-ended reasons map to driver-readable text', () {
    expect(offerEndedNotice('trip_taken'), 'Another driver accepted this ride');
    expect(offerEndedNotice('lost'), 'Another driver accepted this ride');
    expect(offerEndedNotice('offer_expired'), 'The offer expired');
    expect(offerEndedNotice('revoked'), 'This ride is no longer available');
  });
}
