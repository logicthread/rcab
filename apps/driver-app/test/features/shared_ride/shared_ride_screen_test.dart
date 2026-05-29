import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:driver_app/features/shared_ride/shared_ride_models.dart';
import 'package:driver_app/features/shared_ride/shared_ride_provider.dart';
import 'package:driver_app/features/shared_ride/shared_ride_screen.dart';

class _RecordingSender implements StopConfirmSender {
  final List<({String rideId, int idx, String type})> calls = [];

  @override
  void sendPickupConfirmed({required String rideId, required int sequenceIndex}) {
    calls.add((rideId: rideId, idx: sequenceIndex, type: 'pickup'));
  }

  @override
  void sendDropConfirmed({required String rideId, required int sequenceIndex}) {
    calls.add((rideId: rideId, idx: sequenceIndex, type: 'dropoff'));
  }
}

SharedRideOffer _twoPaxOffer() {
  return const SharedRideOffer(
    sharedRideId: 'ride-1',
    passengerCount: 2,
    stops: [
      SharedRideStop(sequenceIndex: 0, passengerId: 'pa', type: StopType.pickup,  lat: 1, lng: 2),
      SharedRideStop(sequenceIndex: 1, passengerId: 'pb', type: StopType.pickup,  lat: 1, lng: 2),
      SharedRideStop(sequenceIndex: 2, passengerId: 'pa', type: StopType.dropoff, lat: 3, lng: 4),
      SharedRideStop(sequenceIndex: 3, passengerId: 'pb', type: StopType.dropoff, lat: 3, lng: 4),
    ],
  );
}

Widget _wrap({
  required _RecordingSender sender,
  required GoRouter router,
  SharedRideOffer? seedOffer,
}) {
  final container = ProviderContainer(
    overrides: [
      sharedRideSenderProvider.overrideWithValue(sender),
    ],
  );
  if (seedOffer != null) {
    container.read(sharedRideProvider.notifier).applyOffer(seedOffer);
  }
  return UncontrolledProviderScope(
    container: container,
    child: MaterialApp.router(routerConfig: router),
  );
}

GoRouter _router(String ride) {
  return GoRouter(
    initialLocation: '/ride/$ride',
    routes: [
      GoRoute(
        path: '/ride/:id',
        builder: (_, st) => SharedRideScreen(rideId: st.pathParameters['id']!),
      ),
      GoRoute(
        path: '/rating/:id',
        builder: (_, st) => Scaffold(
          body: Center(child: Text('rating-${st.pathParameters['id']}')),
        ),
      ),
    ],
  );
}

void main() {
  testWidgets('renders empty state when no shared ride is active', (tester) async {
    final sender = _RecordingSender();
    await tester.pumpWidget(_wrap(sender: sender, router: _router('ride-1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('shared_ride_empty')), findsOneWidget);
  });

  testWidgets('renders 4 stops + confirm button after applyOffer', (tester) async {
    final sender = _RecordingSender();
    await tester.pumpWidget(_wrap(
      sender: sender,
      router: _router('ride-1'),
      seedOffer: _twoPaxOffer(),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('shared_ride_stop_list')), findsOneWidget);
    expect(find.byKey(const Key('stop_0')), findsOneWidget);
    expect(find.byKey(const Key('stop_3')), findsOneWidget);
    expect(find.byKey(const Key('shared_ride_confirm_button')), findsOneWidget);
  });

  testWidgets('confirm button sends pickup event for stop 0', (tester) async {
    final sender = _RecordingSender();
    await tester.pumpWidget(_wrap(
      sender: sender,
      router: _router('ride-1'),
      seedOffer: _twoPaxOffer(),
    ));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('shared_ride_confirm_button')));
    await tester.pumpAndSettle();
    expect(sender.calls, hasLength(1));
    expect(sender.calls.single.idx, 0);
    expect(sender.calls.single.type, 'pickup');
  });

  testWidgets('button label switches to dropoff once pickups are confirmed', (tester) async {
    final sender = _RecordingSender();
    final container = ProviderContainer(
      overrides: [sharedRideSenderProvider.overrideWithValue(sender)],
    );
    container.read(sharedRideProvider.notifier).applyOffer(_twoPaxOffer());

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: _router('ride-1')),
    ));
    await tester.pumpAndSettle();

    // Echo back both pickups.
    final notifier = container.read(sharedRideProvider.notifier);
    notifier.applyServerEcho(
      rideId: 'ride-1', sequenceIndex: 0,
      confirmedAt: DateTime.utc(2026, 5, 29, 12), rideCompleted: false,
    );
    notifier.applyServerEcho(
      rideId: 'ride-1', sequenceIndex: 1,
      confirmedAt: DateTime.utc(2026, 5, 29, 12, 1), rideCompleted: false,
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('Dropped off'), findsOneWidget);
  });

  testWidgets('navigates to /rating/:id when ride completes', (tester) async {
    final sender = _RecordingSender();
    final container = ProviderContainer(
      overrides: [sharedRideSenderProvider.overrideWithValue(sender)],
    );
    container.read(sharedRideProvider.notifier).applyOffer(_twoPaxOffer());

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: _router('ride-1')),
    ));
    await tester.pumpAndSettle();

    final notifier = container.read(sharedRideProvider.notifier);
    for (var i = 0; i < 4; i += 1) {
      notifier.applyServerEcho(
        rideId: 'ride-1', sequenceIndex: i,
        confirmedAt: DateTime.utc(2026, 5, 29, 12, i),
        rideCompleted: i == 3,
      );
    }
    await tester.pumpAndSettle();

    expect(find.text('rating-ride-1'), findsOneWidget);
  });
}
