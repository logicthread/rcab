import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:driver_app/features/ride/ride_models.dart';
import 'package:driver_app/features/ride/ride_provider.dart';
import 'package:driver_app/features/ride/ride_screen.dart';

class _FakeRideService implements RideService {
  _FakeRideService(this.status, {this.advanceTo});

  final String status;
  final String? advanceTo;
  final List<String> advanced = [];

  @override
  Future<RideDetail> getRide(String rideId) async => RideDetail(
        rideId: rideId,
        status: status,
        originLat: 26.10,
        originLng: 91.70,
        destLat: 26.20,
        destLng: 91.80,
      );

  @override
  Future<String> advance(String rideId, String event) async {
    advanced.add(event);
    return advanceTo ?? status;
  }
}

Future<({_FakeRideService svc, List<Uri> launched})> _pump(
  WidgetTester tester, {
  required String status,
  String? advanceTo,
  GoRouter? router,
}) async {
  final svc = _FakeRideService(status, advanceTo: advanceTo);
  final launched = <Uri>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        rideServiceProvider.overrideWithValue(svc),
        mapsLauncherProvider.overrideWithValue((Uri uri) async {
          launched.add(uri);
          return true;
        }),
      ],
      child: router == null
          ? const MaterialApp(home: RideScreen(rideId: 'r-1'))
          : MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
  return (svc: svc, launched: launched);
}

void main() {
  testWidgets('accepted renders status, Navigate-to-pickup, and Start trip', (tester) async {
    await _pump(tester, status: 'accepted');
    expect(find.byKey(const Key('ride_screen')), findsOneWidget);
    expect(find.byKey(const Key('ride_status')), findsOneWidget);
    expect(find.text('Heading to pickup'), findsOneWidget);
    expect(find.byKey(const Key('ride_navigate_button')), findsOneWidget);
    expect(find.text('Navigate to pickup'), findsOneWidget);
    expect(find.byKey(const Key('ride_action_button')), findsOneWidget);
    expect(find.text('Start trip'), findsOneWidget);
  });

  testWidgets('arrived shows the Start ride action', (tester) async {
    await _pump(tester, status: 'arrived');
    expect(find.text('Start ride'), findsOneWidget);
  });

  testWidgets('in_progress flips Navigate to the dropoff target', (tester) async {
    final r = await _pump(tester, status: 'in_progress');
    expect(find.text('Navigate to dropoff'), findsOneWidget);
    expect(find.text('End ride'), findsOneWidget);
    await tester.tap(find.byKey(const Key('ride_navigate_button')));
    await tester.pump();
    expect(r.launched.single, Uri.parse('google.navigation:q=26.2,91.8&mode=d'));
  });

  testWidgets('Navigate from accepted opens the pickup coords', (tester) async {
    final r = await _pump(tester, status: 'accepted');
    await tester.tap(find.byKey(const Key('ride_navigate_button')));
    await tester.pump();
    expect(r.launched.single, Uri.parse('google.navigation:q=26.1,91.7&mode=d'));
  });

  testWidgets('tapping the action button advances with the matching event', (tester) async {
    final r = await _pump(tester, status: 'accepted', advanceTo: 'en_route');
    await tester.tap(find.byKey(const Key('ride_action_button')));
    await tester.pumpAndSettle();
    expect(r.svc.advanced.single, 'start_en_route');
    expect(find.text('En route to pickup'), findsOneWidget);
  });

  testWidgets('completing the ride routes on to /rating/:id', (tester) async {
    final router = GoRouter(
      initialLocation: '/ride/r-1',
      routes: [
        GoRoute(
          path: '/ride/:id',
          builder: (_, s) => RideScreen(rideId: s.pathParameters['id']!),
        ),
        GoRoute(
          path: '/rating/:id',
          builder: (_, s) => Scaffold(
            body: Text('RATING ${s.pathParameters['id']}', key: const Key('rating_marker')),
          ),
        ),
      ],
    );
    await _pump(tester, status: 'in_progress', advanceTo: 'completed', router: router);
    await tester.tap(find.byKey(const Key('ride_action_button'))); // End ride
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('rating_marker')), findsOneWidget);
    expect(find.text('RATING r-1'), findsOneWidget);
  });
}
