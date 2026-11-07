import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/offer/offer_controller.dart';
import 'package:driver_app/features/offer/offer_models.dart';
import 'package:driver_app/features/offer/offer_provider.dart';

import '../../support/fake_realtime_socket.dart';

typedef _FakeSocket = FakeRealtimeSocket;

Map<String, dynamic> _soloOfferJson({
  String offerId = 'o-1',
  String rideId = 'r-1',
  int ttlMs = 12000,
}) => {
      'offerId': offerId,
      'rideId': rideId,
      'ttlMs': ttlMs,
      'pickup': {'lat': 26.14, 'lng': 91.73},
      'dropoff': {'lat': 26.18, 'lng': 91.75},
      'fareCents': 25000,
      'waveNumber': 1,
    };

({ProviderContainer container, _FakeSocket socket, List<String> navStack, OfferController ctrl})
    _make({Duration tick = const Duration(seconds: 1)}) {
  final socket = _FakeSocket();
  final container = ProviderContainer(
    overrides: [realtimeSocketProvider.overrideWithValue(socket)],
  );
  addTearDown(container.dispose);
  final navStack = <String>[];
  final ctrl = OfferController(
    container: container,
    navigate: navStack.add,
    tickInterval: tick,
  );
  return (container: container, socket: socket, navStack: navStack, ctrl: ctrl);
}

void main() {
  group('OfferNotifier', () {
    late ProviderContainer container;
    late _FakeSocket socket;

    OfferNotifier notifier() => container.read(offerProvider.notifier);
    OfferState read() => container.read(offerProvider);
    SoloRideOffer offer({String id = 'o-1', int ttlMs = 12000}) =>
        SoloRideOffer.tryFromRideOfferJson(_soloOfferJson(offerId: id, ttlMs: ttlMs))!;

    setUp(() {
      socket = _FakeSocket();
      container = ProviderContainer(
        overrides: [realtimeSocketProvider.overrideWithValue(socket)],
      );
      addTearDown(container.dispose);
    });

    test('applyOffer → ringing + secondsLeft seeded from ttlMs', () {
      notifier().applyOffer(offer(ttlMs: 12000));
      expect(read().phase, OfferPhase.ringing);
      expect(read().secondsLeft, 12);
      expect(read().offer?.offerId, 'o-1');
    });

    test('tick decrements, then flips to expired at zero and stays', () {
      notifier().applyOffer(offer(ttlMs: 3000));
      notifier()
        ..tick()
        ..tick();
      expect(read().secondsLeft, 1);
      expect(read().phase, OfferPhase.ringing);
      notifier().tick();
      expect(read().phase, OfferPhase.expired);
      expect(read().secondsLeft, 0);
      notifier().tick(); // no-op once expired
      expect(read().phase, OfferPhase.expired);
    });

    test('accept → claiming + emits ride_offer_response accept:true', () {
      notifier().applyOffer(offer());
      notifier().accept();
      expect(read().phase, OfferPhase.claiming);
      expect(socket.sent.single.event, 'ride_offer_response');
      expect(socket.sent.single.data, {'offerId': 'o-1', 'accept': true});
    });

    test('decline → emits accept:false + resets to idle', () {
      notifier().applyOffer(offer());
      notifier().decline();
      expect(socket.sent.single.data, {'offerId': 'o-1', 'accept': false});
      expect(read().phase, OfferPhase.idle);
      expect(read().offer, isNull);
    });

    test('applyAccepted: matching wins, non-matching ignored', () {
      notifier().applyOffer(offer(id: 'o-1'));
      expect(notifier().applyAccepted(offerId: 'other', rideId: 'r-x'), isFalse);
      expect(read().phase, OfferPhase.ringing);
      expect(notifier().applyAccepted(offerId: 'o-1', rideId: 'r-1'), isTrue);
      expect(read().phase, OfferPhase.accepted);
      expect(read().rideId, 'r-1');
    });

    test('applyRevoked: matching → revoked + reason', () {
      notifier().applyOffer(offer(id: 'o-1'));
      expect(notifier().applyRevoked(offerId: 'o-1', reason: 'taken'), isTrue);
      expect(read().phase, OfferPhase.revoked);
      expect(read().revokeReason, 'taken');
    });
  });

  group('OfferController routing', () {
    test('solo ride_offer → applyOffer + navigate /offer/:offerId', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1'));
      await Future<void>.delayed(Duration.zero);
      expect(h.container.read(offerProvider).offer?.offerId, 'o-1');
      expect(h.navStack, ['/offer/o-1']);
      h.ctrl.stop();
    });

    test('shared offer (stops[]) is ignored', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer({
        'offerId': 'o',
        'sharedRideId': 'sr',
        'stops': [
          {'sequenceIndex': 0, 'passengerId': 'p', 'type': 'pickup', 'lat': 0.0, 'lng': 0.0},
        ],
      });
      await Future<void>.delayed(Duration.zero);
      expect(h.container.read(offerProvider).offer, isNull);
      expect(h.navStack, isEmpty);
      h.ctrl.stop();
    });

    test('ride_offer_accepted (match) → navigate /ride/:rideId', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.socket.emitAccepted({'offerId': 'o-1', 'rideId': 'r-1'});
      await Future<void>.delayed(Duration.zero);
      expect(h.navStack, ['/offer/o-1', '/ride/r-1']);
      expect(h.container.read(offerProvider).phase, OfferPhase.accepted);
      h.ctrl.stop();
    });

    test('ride_offer_accepted for a different offer is ignored', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.socket.emitAccepted({'offerId': 'stale', 'rideId': 'r-stale'});
      await Future<void>.delayed(Duration.zero);
      expect(h.navStack, ['/offer/o-1']);
      h.ctrl.stop();
    });

    test('ride_offer_revoked (match) → navigate /home', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1'));
      h.socket.emitRevoked({'offerId': 'o-1', 'reason': 'taken'});
      await Future<void>.delayed(Duration.zero);
      expect(h.navStack, ['/offer/o-1', '/home']);
      expect(h.container.read(offerProvider).phase, OfferPhase.revoked);
      h.ctrl.stop();
    });

    test('countdown expiry → navigate /home', () async {
      final h = _make(tick: const Duration(milliseconds: 5));
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', ttlMs: 1000)); // secondsLeft = 1
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(h.container.read(offerProvider).phase, OfferPhase.expired);
      expect(h.navStack, contains('/home'));
      h.ctrl.stop();
    });
  });

  group('OfferController explicit outcomes + assignment snapshot (R09)', () {
    test('assigned outcome (ack) for the live solo offer → /ride/:id; the event dup is a no-op', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.container.read(offerProvider.notifier).accept();
      h.socket.emitOutcome({
        'offerId': 'o-1', 'outcome': 'assigned', 'tripKind': 'solo', 'tripId': 'r-1', 'source': 'ack',
      });
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'assigned', 'tripKind': 'solo', 'tripId': 'r-1'});
      h.socket.emitAccepted({'offerId': 'o-1', 'rideId': 'r-1'});
      expect(h.navStack, ['/offer/o-1', '/ride/r-1']);
      h.ctrl.stop();
    });

    test('a refused accept (driver_busy) ends the offer immediately', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1'));
      h.container.read(offerProvider.notifier).accept();
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'rejected', 'reason': 'driver_busy'});
      expect(h.container.read(offerProvider).phase, OfferPhase.revoked);
      expect(h.container.read(offerProvider).revokeReason, 'driver_busy');
      expect(h.navStack, ['/offer/o-1', '/home']);
      h.ctrl.stop();
    });

    test('a late loss never undoes a won offer', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.socket.emitAccepted({'offerId': 'o-1', 'rideId': 'r-1'});
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'lost'});
      expect(h.container.read(offerProvider).phase, OfferPhase.accepted);
      expect(h.navStack, ['/offer/o-1', '/ride/r-1']);
      h.ctrl.stop();
    });

    test('retry returns a claiming offer to ringing', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1'));
      h.container.read(offerProvider.notifier).accept();
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'retry', 'reason': 'conflict'});
      expect(h.container.read(offerProvider).phase, OfferPhase.ringing);
      h.ctrl.stop();
    });

    test('shared outcomes are left to the shared-ride controller', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitOutcome({'offerId': 'o-9', 'outcome': 'assigned', 'tripKind': 'shared', 'tripId': 'p-1'});
      expect(h.navStack, isEmpty);
      h.ctrl.stop();
    });

    test('cold start: a solo assignment snapshot restores /ride/:id once per trip', () async {
      final h = _make();
      await h.ctrl.start();
      final snap = {
        'driverId': 'd',
        'assignment': {'tripKind': 'solo', 'tripId': 'r-7', 'offerId': 'o-7', 'generation': 1},
      };
      h.socket.emitAssignment(snap);
      h.socket.emitAssignment(snap); // reconnect: same trip, no re-navigation
      expect(h.navStack, ['/ride/r-7']);
      h.socket.emitAssignment({'driverId': 'd', 'assignment': null});
      h.socket.emitAssignment(snap);
      expect(h.navStack, ['/ride/r-7', '/ride/r-7']);
      h.ctrl.stop();
    });

    test('lost ack: the snapshot naming our claiming offer completes the win', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.container.read(offerProvider.notifier).accept();
      h.socket.emitAssignment({
        'driverId': 'd',
        'assignment': {'tripKind': 'solo', 'tripId': 'r-1', 'offerId': 'o-1', 'generation': 1},
      });
      expect(h.container.read(offerProvider).phase, OfferPhase.accepted);
      expect(h.navStack, ['/offer/o-1', '/ride/r-1']);
      h.ctrl.stop();
    });

    test('ack unavailable keeps claiming + asks for a snapshot (no abandon)', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.container.read(offerProvider.notifier).accept();
      final before = h.socket.snapshotRequests;
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'unknown', 'reason': 'unavailable', 'source': 'ack'});
      expect(h.container.read(offerProvider).phase, OfferPhase.claiming);
      expect(h.socket.snapshotRequests, before + 1);
      expect(h.navStack, ['/offer/o-1']);
      h.ctrl.stop();
    });

    test('unavailable then snapshot with the assignment -> /ride/:id', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.container.read(offerProvider.notifier).accept();
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'unknown', 'reason': 'unavailable'});
      h.socket.emitAssignment({
        'driverId': 'd',
        'assignment': {'tripKind': 'solo', 'tripId': 'r-1', 'offerId': 'o-1', 'generation': 1},
      });
      expect(h.container.read(offerProvider).phase, OfferPhase.accepted);
      expect(h.navStack, ['/offer/o-1', '/ride/r-1']);
      h.ctrl.stop();
    });

    test('unavailable then empty snapshot -> home', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.container.read(offerProvider.notifier).accept();
      h.socket.emitOutcome({'offerId': 'o-1', 'outcome': 'unknown', 'reason': 'unavailable'});
      h.socket.emitAssignment({'driverId': 'd', 'assignment': null});
      expect(h.container.read(offerProvider).phase, OfferPhase.revoked);
      expect(h.navStack, ['/offer/o-1', '/home']);
      h.ctrl.stop();
    });

    test('an empty snapshot without a prior unavailable does not end a claiming offer', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer(_soloOfferJson(offerId: 'o-1', rideId: 'r-1'));
      h.container.read(offerProvider.notifier).accept();
      h.socket.emitAssignment({'driverId': 'd', 'assignment': null});
      expect(h.container.read(offerProvider).phase, OfferPhase.claiming);
      h.ctrl.stop();
    });
  });
}
