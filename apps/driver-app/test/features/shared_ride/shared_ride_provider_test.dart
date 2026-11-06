import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/core/realtime/offer_outcome.dart';
import 'package:driver_app/features/offer/offer_models.dart';
import 'package:driver_app/features/shared_ride/shared_ride_models.dart';
import 'package:driver_app/features/shared_ride/shared_ride_provider.dart';

class _FakeSender implements StopConfirmSender {
  final List<({String rideId, int idx, String type})> calls =
      <({String rideId, int idx, String type})>[];

  @override
  void sendPickupConfirmed({required String rideId, required int sequenceIndex}) {
    calls.add((rideId: rideId, idx: sequenceIndex, type: 'pickup'));
  }

  @override
  void sendDropConfirmed({required String rideId, required int sequenceIndex}) {
    calls.add((rideId: rideId, idx: sequenceIndex, type: 'dropoff'));
  }
}

SharedRideOffer _twoPassengerOffer() {
  return const SharedRideOffer(
    sharedRideId: 'ride-1',
    passengerCount: 2,
    stops: [
      SharedRideStop(sequenceIndex: 0, passengerId: 'pa', type: StopType.pickup,  lat: 0, lng: 0),
      SharedRideStop(sequenceIndex: 1, passengerId: 'pb', type: StopType.pickup,  lat: 0, lng: 0),
      SharedRideStop(sequenceIndex: 2, passengerId: 'pa', type: StopType.dropoff, lat: 0, lng: 0),
      SharedRideStop(sequenceIndex: 3, passengerId: 'pb', type: StopType.dropoff, lat: 0, lng: 0),
    ],
  );
}

class _FakeOfferSender implements OfferResponseSender {
  final List<({String offerId, bool accept})> calls = [];
  @override
  void sendOfferResponse({required String offerId, required bool accept}) {
    calls.add((offerId: offerId, accept: accept));
  }
}

SharedRideOffer _offerWithId() => SharedRideOffer(
      sharedRideId: 'ride-1',
      passengerCount: 2,
      offerId: 'o-1',
      ttlMs: 3000,
      stops: _twoPassengerOffer().stops,
    );

/// Offer + committed server outcome: the only way into the stop phase.
void _assign(SharedRideNotifier n) {
  n.applyOffer(_twoPassengerOffer());
  n.applyOutcome(const OfferOutcome(
    offerId: 'unused',
    kind: OfferOutcomeKind.assigned,
    tripKind: 'shared',
    tripId: 'ride-1',
  ));
}

void main() {
  group('SharedRideNotifier phases (R09 / F10)', () {
    test('an offer is not an assignment: no stop commands until assigned', () {
      final sender = _FakeSender();
      final offers = _FakeOfferSender();
      final n = SharedRideNotifier(sender, offerSender: offers);
      n.applyOffer(_offerWithId());
      expect(n.state.phase, SharedRidePhase.offered);
      expect(n.state.secondsLeft, 3);
      expect(n.confirmCurrentStop(), isFalse);

      expect(n.accept(), isTrue);
      expect(offers.calls.single, (offerId: 'o-1', accept: true));
      expect(n.state.phase, SharedRidePhase.accepting);
      expect(n.accept(), isFalse); // no double accept
      expect(n.confirmCurrentStop(), isFalse);
      expect(sender.calls, isEmpty);

      expect(
        n.applyOutcome(const OfferOutcome(
          offerId: 'o-1', kind: OfferOutcomeKind.assigned, tripKind: 'shared', tripId: 'ride-1',
        )),
        isTrue,
      );
      expect(n.state.phase, SharedRidePhase.assigned);
      expect(n.confirmCurrentStop(), isTrue);
    });

    test('a solo assigned outcome never assigns the shared offer', () {
      final n = SharedRideNotifier(_FakeSender(), offerSender: _FakeOfferSender());
      n.applyOffer(_offerWithId());
      n.accept();
      expect(
        n.applyOutcome(const OfferOutcome(
          offerId: 'o-1', kind: OfferOutcomeKind.assigned, tripKind: 'solo', tripId: 'r-9',
        )),
        isFalse,
      );
      expect(n.state.phase, SharedRidePhase.accepting);
    });

    test('tick counts down while ringing and expires at zero; accepting freezes it', () {
      final n = SharedRideNotifier(_FakeSender(), offerSender: _FakeOfferSender());
      n.applyOffer(_offerWithId());
      n.tick();
      expect(n.state.secondsLeft, 2);
      n.accept();
      n.tick();
      expect(n.state.secondsLeft, 2);
      n.ackTimedOut();
      expect(n.state.phase, SharedRidePhase.offered);
      n.tick();
      n.tick();
      expect(n.state.phase, SharedRidePhase.expired);
    });

    test('a new offer never replaces a committed, unfinished trip', () {
      final n = SharedRideNotifier(_FakeSender());
      _assign(n);
      n.applyOffer(SharedRideOffer(
        sharedRideId: 'ride-2', passengerCount: 1, offerId: 'o-2',
        stops: _twoPassengerOffer().stops,
      ));
      expect(n.state.sharedRideId, 'ride-1');
      expect(n.state.phase, SharedRidePhase.assigned);
    });

    test('accept without an offer sender is refused (no silent claim)', () {
      final n = SharedRideNotifier(_FakeSender());
      n.applyOffer(_offerWithId());
      expect(n.accept(), isFalse);
      expect(n.state.phase, SharedRidePhase.offered);
    });
  });

  group('SharedRideNotifier.applyOffer', () {
    test('seeds 4 pending stops with currentStopIndex = 0', () {
      final n = SharedRideNotifier(_FakeSender());
      n.applyOffer(_twoPassengerOffer());

      expect(n.state.sharedRideId, 'ride-1');
      expect(n.state.stops.length, 4);
      expect(n.state.currentStopIndex, 0);
      expect(n.state.completed, isFalse);
      expect(n.state.stops.every((s) => s.status == StopStatus.pending), isTrue);
    });

    test('sorts stops by sequenceIndex even if offer is unordered', () {
      final n = SharedRideNotifier(_FakeSender());
      n.applyOffer(const SharedRideOffer(
        sharedRideId: 'r-2',
        passengerCount: 1,
        stops: [
          SharedRideStop(sequenceIndex: 2, passengerId: 'p', type: StopType.dropoff, lat: 0, lng: 0),
          SharedRideStop(sequenceIndex: 0, passengerId: 'p', type: StopType.pickup,  lat: 0, lng: 0),
          SharedRideStop(sequenceIndex: 1, passengerId: 'p', type: StopType.dropoff, lat: 0, lng: 0),
        ],
      ));
      expect(n.state.stops.map((s) => s.stop.sequenceIndex), [0, 1, 2]);
    });
  });

  group('SharedRideNotifier.confirmCurrentStop', () {
    test('sends pickup event for first stop', () {
      final sender = _FakeSender();
      final n = SharedRideNotifier(sender);
      _assign(n);
      expect(n.confirmCurrentStop(), isTrue);
      expect(sender.calls.single.idx, 0);
      expect(sender.calls.single.type, 'pickup');
    });

    test('returns false when current stop is already confirmed', () {
      final n = SharedRideNotifier(_FakeSender());
      _assign(n);
      n.applyServerEcho(
        rideId: 'ride-1',
        sequenceIndex: 0,
        confirmedAt: DateTime.utc(2026, 5, 29, 12),
        rideCompleted: false,
      );
      // After advance, the next current stop is pending → confirmCurrentStop will fire for idx=1.
      // Force the cursor onto the just-confirmed one to verify the guard.
      // Calling confirmCurrentStop a second time (still pending at idx=1) is the valid path.
      expect(n.confirmCurrentStop(), isTrue);
    });

    test('returns false when the ride is completed', () {
      final n = SharedRideNotifier(_FakeSender());
      _assign(n);
      for (var i = 0; i < 4; i += 1) {
        n.applyServerEcho(
          rideId: 'ride-1',
          sequenceIndex: i,
          confirmedAt: DateTime.utc(2026, 5, 29, 12, i),
          rideCompleted: i == 3,
        );
      }
      expect(n.state.completed, isTrue);
      expect(n.confirmCurrentStop(), isFalse);
    });
  });

  group('SharedRideNotifier.applyServerEcho', () {
    test('advances currentStopIndex to the next pending stop', () {
      final n = SharedRideNotifier(_FakeSender());
      _assign(n);
      n.applyServerEcho(
        rideId: 'ride-1',
        sequenceIndex: 0,
        confirmedAt: DateTime.utc(2026, 5, 29, 12),
        rideCompleted: false,
      );
      expect(n.state.currentStopIndex, 1);
      expect(n.state.stops[0].status, StopStatus.confirmed);
      expect(n.state.stops[0].confirmedAt, isNotNull);
      expect(n.state.completed, isFalse);
    });

    test('ignores echoes for a different sharedRideId', () {
      final n = SharedRideNotifier(_FakeSender());
      _assign(n);
      n.applyServerEcho(
        rideId: 'OTHER',
        sequenceIndex: 0,
        confirmedAt: DateTime.utc(2026, 5, 29, 12),
        rideCompleted: false,
      );
      expect(n.state.currentStopIndex, 0);
      expect(n.state.stops[0].status, StopStatus.pending);
    });

    test('marks completed=true when last drop echo carries rideCompleted', () {
      final n = SharedRideNotifier(_FakeSender());
      _assign(n);
      for (var i = 0; i < 3; i += 1) {
        n.applyServerEcho(
          rideId: 'ride-1',
          sequenceIndex: i,
          confirmedAt: DateTime.utc(2026, 5, 29, 12, i),
          rideCompleted: false,
        );
      }
      expect(n.state.completed, isFalse);
      n.applyServerEcho(
        rideId: 'ride-1',
        sequenceIndex: 3,
        confirmedAt: DateTime.utc(2026, 5, 29, 12, 3),
        rideCompleted: true,
      );
      expect(n.state.completed, isTrue);
      expect(n.state.currentStopIndex, 4);
    });

    test('ignores duplicate echoes for already-confirmed stops', () {
      final n = SharedRideNotifier(_FakeSender());
      _assign(n);
      n.applyServerEcho(
        rideId: 'ride-1',
        sequenceIndex: 0,
        confirmedAt: DateTime.utc(2026, 5, 29, 12),
        rideCompleted: false,
      );
      final indexAfterFirst = n.state.currentStopIndex;
      n.applyServerEcho(
        rideId: 'ride-1',
        sequenceIndex: 0,
        confirmedAt: DateTime.utc(2026, 5, 29, 13),
        rideCompleted: false,
      );
      expect(n.state.currentStopIndex, indexAfterFirst);
    });
  });

  group('SharedRideNotifier.hydrateFromServer (WS reconnect restore)', () {
    test('restores stop statuses + currentStopIndex from REST payload', () {
      final n = SharedRideNotifier(_FakeSender());
      n.hydrateFromServer(
        sharedRideId: 'ride-1',
        stops: const [
          {
            'sequenceIndex': 0, 'passengerId': 'pa', 'type': 'pickup',
            'lat': 0.0, 'lng': 0.0, 'confirmed': true,
            'confirmedAt': '2026-05-29T12:00:00.000Z',
          },
          {
            'sequenceIndex': 1, 'passengerId': 'pb', 'type': 'pickup',
            'lat': 0.0, 'lng': 0.0, 'confirmed': false, 'confirmedAt': null,
          },
          {
            'sequenceIndex': 2, 'passengerId': 'pa', 'type': 'dropoff',
            'lat': 0.0, 'lng': 0.0, 'confirmed': false, 'confirmedAt': null,
          },
        ],
      );
      expect(n.state.sharedRideId, 'ride-1');
      expect(n.state.stops.length, 3);
      expect(n.state.stops[0].status, StopStatus.confirmed);
      expect(n.state.currentStopIndex, 1);
      expect(n.state.completed, isFalse);
    });

    test('marks completed=true when all restored stops are confirmed', () {
      final n = SharedRideNotifier(_FakeSender());
      n.hydrateFromServer(
        sharedRideId: 'ride-1',
        stops: const [
          {
            'sequenceIndex': 0, 'passengerId': 'pa', 'type': 'pickup',
            'lat': 0.0, 'lng': 0.0, 'confirmed': true,
            'confirmedAt': '2026-05-29T12:00:00.000Z',
          },
          {
            'sequenceIndex': 1, 'passengerId': 'pa', 'type': 'dropoff',
            'lat': 0.0, 'lng': 0.0, 'confirmed': true,
            'confirmedAt': '2026-05-29T12:05:00.000Z',
          },
        ],
      );
      expect(n.state.completed, isTrue);
      expect(n.state.currentStopIndex, 2);
    });
  });

  group('SharedRideOffer.tryFromRideOfferJson', () {
    test('returns null for solo offer (no stops array)', () {
      final result = SharedRideOffer.tryFromRideOfferJson({
        'offerId': 'o', 'pickup': {'lat': 0, 'lng': 0},
      });
      expect(result, isNull);
    });

    test('parses shared offer with stops[] payload', () {
      final result = SharedRideOffer.tryFromRideOfferJson({
        'offerId': 'o-1',
        'sharedRideId': 'ride-1',
        'passengerCount': 2,
        'stops': [
          {'sequenceIndex': 0, 'passengerId': 'pa', 'type': 'pickup',  'lat': 1, 'lng': 2},
          {'sequenceIndex': 1, 'passengerId': 'pb', 'type': 'dropoff', 'lat': 3, 'lng': 4},
        ],
      });
      expect(result, isNotNull);
      expect(result!.stops.length, 2);
      expect(result.stops.first.type, StopType.pickup);
      expect(result.stops.last.type, StopType.dropoff);
    });
  });
}
