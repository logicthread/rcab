import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/core/realtime/realtime_socket.dart';
import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/offer/offer_controller.dart';
import 'package:driver_app/features/offer/offer_models.dart';
import 'package:driver_app/features/offer/offer_provider.dart';

class _FakeSocket implements IRealtimeSocket {
  final _rideOffer = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideOfferAccepted = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideOfferRevoked = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _stopPickup = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _stopDrop = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideCompleted = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _driverState = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final List<({String event, Map<String, dynamic> data})> sent = [];

  @override
  Stream<Map<String, dynamic>> get rideOffer => _rideOffer.stream;
  @override
  Stream<Map<String, dynamic>> get rideOfferAccepted => _rideOfferAccepted.stream;
  @override
  Stream<Map<String, dynamic>> get rideOfferRevoked => _rideOfferRevoked.stream;
  @override
  Stream<Map<String, dynamic>> get stopPickupConfirmed => _stopPickup.stream;
  @override
  Stream<Map<String, dynamic>> get stopDropConfirmed => _stopDrop.stream;
  @override
  Stream<Map<String, dynamic>> get rideCompleted => _rideCompleted.stream;
  @override
  Stream<Map<String, dynamic>> get driverState => _driverState.stream;

  @override
  Future<void> connect() async {}
  @override
  void disconnect() {}

  @override
  void sendOfferResponse({required String offerId, required bool accept}) {
    sent.add((event: 'ride_offer_response', data: {'offerId': offerId, 'accept': accept}));
  }

  @override
  void sendPickupConfirmed({required String rideId, required int sequenceIndex}) {}
  @override
  void sendDropConfirmed({required String rideId, required int sequenceIndex}) {}

  @override
  Future<void> dispose() async {
    await Future.wait([
      _rideOffer.close(), _rideOfferAccepted.close(), _rideOfferRevoked.close(),
      _stopPickup.close(), _stopDrop.close(), _rideCompleted.close(), _driverState.close(),
    ]);
  }

  void emitRideOffer(Map<String, dynamic> p) => _rideOffer.add(p);
  void emitAccepted(Map<String, dynamic> p) => _rideOfferAccepted.add(p);
  void emitRevoked(Map<String, dynamic> p) => _rideOfferRevoked.add(p);
}

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
}
