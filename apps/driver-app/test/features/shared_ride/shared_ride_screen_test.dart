import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:driver_app/core/realtime/offer_outcome.dart';
import 'package:driver_app/features/offer/offer_models.dart';
import 'package:driver_app/features/offer/offer_provider.dart';
import 'package:driver_app/features/shared_ride/shared_ride_models.dart';
import 'package:driver_app/features/shared_ride/shared_ride_provider.dart';
import 'package:driver_app/features/home/driver_notice.dart';
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

class _RecordingOfferSender implements OfferResponseSender {
  final List<({String offerId, bool accept})> calls = [];
  @override
  void sendOfferResponse({required String offerId, required bool accept}) {
    calls.add((offerId: offerId, accept: accept));
  }
}

const _assigned = OfferOutcome(
  offerId: 'o-1',
  kind: OfferOutcomeKind.assigned,
  tripKind: 'shared',
  tripId: 'ride-1',
);

SharedRideOffer _twoPaxOffer() {
  return const SharedRideOffer(
    sharedRideId: 'ride-1',
    offerId: 'o-1',
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
    container.read(sharedRideProvider.notifier)
      ..applyOffer(seedOffer)
      ..applyOutcome(_assigned);
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
      GoRoute(
        path: '/home',
        builder: (_, __) => const Scaffold(body: Center(child: Text('home'))),
      ),
    ],
  );
}

void main() {
  testWidgets('an incoming offer shows Accept / Decline, never the stop controls', (tester) async {
    final sender = _RecordingSender();
    final offers = _RecordingOfferSender();
    final container = ProviderContainer(overrides: [
      sharedRideSenderProvider.overrideWithValue(sender),
      offerResponseSenderProvider.overrideWithValue(offers),
    ]);
    addTearDown(container.dispose);
    container.read(sharedRideProvider.notifier).applyOffer(_twoPaxOffer());

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: _router('ride-1')),
    ));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('shared_offer_screen')), findsOneWidget);
    expect(find.byKey(const Key('shared_offer_itinerary')), findsOneWidget);
    expect(find.byKey(const Key('shared_ride_confirm_button')), findsNothing);

    await tester.tap(find.byKey(const Key('shared_offer_accept_button')));
    await tester.pump();
    expect(offers.calls.single, (offerId: 'o-1', accept: true));
    expect(find.byKey(const Key('shared_offer_claiming')), findsOneWidget);
    expect(find.byKey(const Key('shared_ride_confirm_button')), findsNothing);

    // Only the committed outcome brings up the stop screen.
    container.read(sharedRideProvider.notifier).applyOutcome(_assigned);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('shared_ride_confirm_button')), findsOneWidget);
    expect(sender.calls, isEmpty);
  });

  testWidgets('a lost offer shows its outcome, not the stops', (tester) async {
    final container = ProviderContainer(overrides: [
      sharedRideSenderProvider.overrideWithValue(_RecordingSender()),
      offerResponseSenderProvider.overrideWithValue(_RecordingOfferSender()),
    ]);
    addTearDown(container.dispose);
    container.read(sharedRideProvider.notifier)
      ..applyOffer(_twoPaxOffer())
      ..accept()
      ..applyOutcome(const OfferOutcome(offerId: 'o-1', kind: OfferOutcomeKind.lost));

    await tester.pumpWidget(UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(routerConfig: _router('ride-1')),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('shared_offer_outcome')), findsOneWidget);
    expect(find.text('Another driver took this ride'), findsOneWidget);
    expect(find.byKey(const Key('shared_ride_confirm_button')), findsNothing);
  });

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
    container.read(sharedRideProvider.notifier)
      ..applyOffer(_twoPaxOffer())
      ..applyOutcome(_assigned);

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

  // A shared pool is not a `rides` row, so POST /v1/rides/<poolId>/ratings is
  // always 404: the old rating prompt could never be submitted (RCAB-E8.S14).
  testWidgets('returns home with a completion notice when the pool completes (no rating prompt)',
      (tester) async {
    final sender = _RecordingSender();
    final container = ProviderContainer(
      overrides: [sharedRideSenderProvider.overrideWithValue(sender)],
    );
    container.read(sharedRideProvider.notifier)
      ..applyOffer(_twoPaxOffer())
      ..applyOutcome(_assigned);

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

    expect(find.text('rating-ride-1'), findsNothing);
    expect(find.text('home'), findsOneWidget);
    expect(container.read(driverNoticeProvider), 'Shared ride complete · 2 passengers dropped off');
  });
}
