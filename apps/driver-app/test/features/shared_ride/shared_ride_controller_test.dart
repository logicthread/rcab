import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/shared_ride/shared_ride_controller.dart';
import 'package:driver_app/features/shared_ride/shared_ride_models.dart';
import 'package:driver_app/features/shared_ride/shared_ride_provider.dart';

import '../../support/fake_realtime_socket.dart';

({
  ProviderContainer container,
  FakeRealtimeSocket socket,
  List<String> navStack,
  SharedRideController ctrl,
}) _make({
  Duration tick = const Duration(seconds: 1),
  Duration ackTimeout = const Duration(seconds: 8),
}) {
  final socket = FakeRealtimeSocket();
  final container = ProviderContainer(overrides: [
    realtimeSocketProvider.overrideWithValue(socket),
    sharedRideSenderProvider.overrideWithValue(socket),
  ]);
  addTearDown(container.dispose);
  final navStack = <String>[];
  final ctrl = SharedRideController(
    container: container,
    navigate: navStack.add,
    tickInterval: tick,
    ackTimeout: ackTimeout,
  );
  addTearDown(ctrl.stop);
  return (container: container, socket: socket, navStack: navStack, ctrl: ctrl);
}

Map<String, dynamic> _offerJson({String offerId = 'o-1', String ride = 'ride-1', int ttlMs = 12000}) => {
      'offerId': offerId,
      'sharedRideId': ride,
      'passengerCount': 2,
      'ttlMs': ttlMs,
      'stops': [
        {'sequenceIndex': 0, 'passengerId': 'pa', 'type': 'pickup', 'lat': 0.0, 'lng': 0.0},
        {'sequenceIndex': 1, 'passengerId': 'pb', 'type': 'pickup', 'lat': 0.0, 'lng': 0.0},
        {'sequenceIndex': 2, 'passengerId': 'pa', 'type': 'dropoff', 'lat': 0.0, 'lng': 0.0},
        {'sequenceIndex': 3, 'passengerId': 'pb', 'type': 'dropoff', 'lat': 0.0, 'lng': 0.0},
      ],
    };

Map<String, dynamic> _sharedAssignment({
  String ride = 'ride-1',
  String offerId = 'o-1',
  List<bool> confirmed = const [false, false, false, false],
}) =>
    {
      'tripKind': 'shared',
      'tripId': ride,
      'sharedRideId': ride,
      'offerId': offerId,
      'generation': 1,
      'version': 7,
      'poolStatus': 'closed_full',
      'stops': [
        for (var i = 0; i < confirmed.length; i++)
          {
            'sequenceIndex': i,
            'passengerId': i.isEven ? 'pa' : 'pb',
            'type': i < confirmed.length / 2 ? 'pickup' : 'dropoff',
            'lat': 1.0,
            'lng': 2.0,
            'confirmed': confirmed[i],
            'confirmedAt': confirmed[i] ? '2026-11-06T10:00:00.000Z' : null,
          },
      ],
    };

void main() {
  group('incoming shared offer (F10: an offer is not an assignment)', () {
    test('opens /shared-ride/:id in the offered phase; stop commands disabled', () async {
      final h = _make();
      await h.ctrl.start();

      h.socket.emitRideOffer(_offerJson());

      final s = h.container.read(sharedRideProvider);
      expect(s.sharedRideId, 'ride-1');
      expect(s.phase, SharedRidePhase.offered);
      expect(s.offerId, 'o-1');
      expect(h.navStack, ['/shared-ride/ride-1']);
      expect(h.container.read(sharedRideProvider.notifier).confirmCurrentStop(), isFalse);
      expect(h.socket.sent.where((e) => e.event.startsWith('stop:')), isEmpty);
    });

    test('ignores solo offers (no stops array)', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer({'offerId': 'o', 'pickup': {'lat': 0, 'lng': 0}});
      expect(h.container.read(sharedRideProvider).sharedRideId, isNull);
      expect(h.navStack, isEmpty);
    });

    test('accept sends the response and waits in accepting; assigned ack enables stops', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_offerJson());
      final n = h.container.read(sharedRideProvider.notifier);

      expect(n.accept(), isTrue);
      expect(h.socket.sent.last.event, 'ride_offer_response');
      expect(h.socket.sent.last.data, {'offerId': 'o-1', 'accept': true});
      expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.accepting);
      expect(n.confirmCurrentStop(), isFalse);

      // Ack (normalised by the socket) arrives first, then the event with the
      // authoritative itinerary: one transition, no extra navigation.
      h.socket.emitOutcome({
        'offerId': 'o-1', 'outcome': 'assigned', 'tripKind': 'shared',
        'tripId': 'ride-1', 'generation': 1, 'source': 'ack',
      });
      h.socket.emitOutcome({
        'offerId': 'o-1', 'outcome': 'assigned', 'tripKind': 'shared',
        'tripId': 'ride-1', 'generation': 1,
        'assignment': _sharedAssignment(confirmed: [true, false, false, false]),
      });

      final s = h.container.read(sharedRideProvider);
      expect(s.phase, SharedRidePhase.assigned);
      expect(s.generation, 1);
      expect(s.currentStopIndex, 1); // hydrated from the committed itinerary
      expect(h.navStack, ['/shared-ride/ride-1']);
      expect(n.confirmCurrentStop(), isTrue);
      expect(h.socket.sent.last.event, 'stop:pickup_confirmed');
    });

    for (final c in [
      ('lost', 'trip_taken', SharedRidePhase.lost),
      ('expired', 'offer_expired', SharedRidePhase.expired),
      ('revoked', 'revoked', SharedRidePhase.revoked),
      ('rejected', 'driver_busy', SharedRidePhase.rejected),
    ]) {
      test('outcome ${c.$1} for our offer → home, never the stop screen', () async {
        final h = _make();
        await h.ctrl.start();
        h.socket.emitRideOffer(_offerJson());
        final n = h.container.read(sharedRideProvider.notifier);
        n.accept();
        final seen = <SharedRidePhase>[];
        h.container.listen<SharedRideState>(sharedRideProvider, (_, next) => seen.add(next.phase));

        h.socket.emitOutcome({'offerId': 'o-1', 'outcome': c.$1, 'reason': c.$2});

        expect(seen.first, c.$3);
        expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.none);
        expect(h.navStack, ['/shared-ride/ride-1', '/home']);
        // A late assigned ack for the abandoned offer cannot resurrect it.
        h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'assigned', 'tripKind': 'shared', 'tripId': 'ride-1'});
        expect(h.container.read(sharedRideProvider).isAssigned, isFalse);
      });
    }

    test('an outcome for another offer is ignored', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_offerJson());
      h.socket.emitOutcome({'offerId': 'o-other', 'outcome': 'lost'});
      expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.offered);
      expect(h.navStack, ['/shared-ride/ride-1']);
    });

    test('a loss after a committed assignment never undoes it', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_offerJson());
      h.container.read(sharedRideProvider.notifier).accept();
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'assigned', 'tripKind': 'shared', 'tripId': 'ride-1'});
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'revoked'});
      expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.assigned);
    });

    test('retry (lock conflict) returns to the offered phase', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_offerJson());
      h.container.read(sharedRideProvider.notifier).accept();
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'retry', 'reason': 'conflict'});
      expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.offered);
    });

    test('countdown expiry while ringing → expired → home', () async {
      final h = _make(tick: const Duration(milliseconds: 5));
      await h.ctrl.start();
      h.socket.emitRideOffer(_offerJson(ttlMs: 2000));
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.none);
      expect(h.navStack, ['/shared-ride/ride-1', '/home']);
    });

    test('decline sends accept:false and clears the offer', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_offerJson());
      h.container.read(sharedRideProvider.notifier).decline();
      expect(h.socket.sent.last.data, {'offerId': 'o-1', 'accept': false});
      expect(h.container.read(sharedRideProvider).isEmpty, isTrue);
    });
  });

  group('lost accept ack', () {
    test('ack timeout asks for a snapshot; the snapshot proves the commit', () async {
      final h = _make(ackTimeout: const Duration(milliseconds: 10));
      await h.ctrl.start();
      final baseline = h.socket.snapshotRequests;
      h.socket.emitRideOffer(_offerJson());
      h.container.read(sharedRideProvider.notifier).accept();

      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(h.socket.snapshotRequests, baseline + 1);
      // Without an answer yet the driver may retry (accept is replay-safe).
      expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.offered);

      h.socket.emitAssignment({'driverId': 'd', 'assignment': _sharedAssignment()});
      final s = h.container.read(sharedRideProvider);
      expect(s.phase, SharedRidePhase.assigned);
      expect(s.offerId, 'o-1');
      expect(s.stops, hasLength(4));
    });
  });

  group('driver:assignment snapshot restore (cold start / reconnect)', () {
    test('requests a snapshot on start', () async {
      final h = _make();
      await h.ctrl.start();
      expect(h.socket.snapshotRequests, 1);
    });

    test('restores the committed shared trip with confirmed stops + navigates', () async {
      final h = _make();
      await h.ctrl.start();

      h.socket.emitAssignment({
        'driverId': 'd',
        'assignment': _sharedAssignment(ride: 'ride-restored', confirmed: [true, false, false, false]),
      });

      final s = h.container.read(sharedRideProvider);
      expect(s.sharedRideId, 'ride-restored');
      expect(s.phase, SharedRidePhase.assigned);
      expect(s.stops.length, 4);
      expect(s.currentStopIndex, 1);
      expect(h.navStack, ['/shared-ride/ride-restored']);

      // The same snapshot on the next reconnect refreshes without re-navigating.
      h.socket.emitAssignment({'driverId': 'd', 'assignment': _sharedAssignment(ride: 'ride-restored')});
      expect(h.navStack, ['/shared-ride/ride-restored']);
    });

    test('no assignment while a trip is shown → it was released → home', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitAssignment({'driverId': 'd', 'assignment': _sharedAssignment()});
      h.socket.emitAssignment({'driverId': 'd', 'assignment': null});
      expect(h.container.read(sharedRideProvider).isEmpty, isTrue);
      expect(h.navStack, ['/shared-ride/ride-1', '/home']);
    });

    test('no assignment while idle or still accepting is a no-op', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitAssignment({'driverId': 'd', 'assignment': null});
      h.socket.emitRideOffer(_offerJson());
      h.container.read(sharedRideProvider.notifier).accept();
      h.socket.emitAssignment({'driverId': 'd', 'assignment': null});
      expect(h.container.read(sharedRideProvider).phase, SharedRidePhase.accepting);
      expect(h.navStack, ['/shared-ride/ride-1']);
    });

    test('a solo assignment is left to the offer controller', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitAssignment({
        'driverId': 'd',
        'assignment': {'tripKind': 'solo', 'tripId': 'r-1', 'offerId': 'o-9', 'generation': 1},
      });
      expect(h.container.read(sharedRideProvider).isEmpty, isTrue);
      expect(h.navStack, isEmpty);
    });

    test('an error ack (no assignment key) is ignored', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitAssignment({'ok': false, 'reason': 'unavailable'});
      expect(h.navStack, isEmpty);
    });
  });

  group('stop echo handling', () {
    test('applies pickup echo to advance currentStopIndex (assigned trip)', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitAssignment({'driverId': 'd', 'assignment': _sharedAssignment()});

      h.socket.emitStopPickup({
        'rideId': 'ride-1', 'sequenceIndex': 0,
        'confirmedAt': '2026-05-29T12:00:00.000Z', 'rideCompleted': false,
      });

      expect(h.container.read(sharedRideProvider).currentStopIndex, 1);
    });

    test('drop echo with rideCompleted=true flips completed state', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitAssignment({'driverId': 'd', 'assignment': _sharedAssignment()});

      for (var i = 0; i < 4; i++) {
        final ev = {
          'rideId': 'ride-1', 'sequenceIndex': i,
          'confirmedAt': '2026-05-29T12:0$i:00.000Z', 'rideCompleted': i == 3,
        };
        i < 2 ? h.socket.emitStopPickup(ev) : h.socket.emitStopDrop(ev);
      }

      expect(h.container.read(sharedRideProvider).completed, isTrue);
    });

    test('echoes are ignored for an offer that is not assigned', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_offerJson());
      h.socket.emitStopPickup({
        'rideId': 'ride-1', 'sequenceIndex': 0,
        'confirmedAt': '2026-05-29T12:00:00.000Z', 'rideCompleted': false,
      });
      expect(h.container.read(sharedRideProvider).currentStopIndex, 0);
    });
  });

  test('stop() cancels subscriptions', () async {
    final h = _make();
    await h.ctrl.start();
    h.ctrl.stop();
    h.socket.emitRideOffer(_offerJson());
    expect(h.navStack, isEmpty);
    unawaited(Future<void>.value());
  });
}
