import 'dart:async';

import 'package:driver_app/core/realtime/realtime_socket.dart';

/// In-memory [IRealtimeSocket] for controller tests: records every emit and
/// lets a test push any server event synchronously.
class FakeRealtimeSocket implements IRealtimeSocket {
  final _rideOffer = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideOfferAccepted = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideOfferRevoked = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _stopPickup = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _stopDrop = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideCompleted = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _driverState = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _outcome = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _assignment = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideState = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final Set<String> rideSubscriptions = <String>{};

  final List<({String event, Map<String, dynamic> data})> sent = [];
  int snapshotRequests = 0;

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
  Stream<Map<String, dynamic>> get rideOfferOutcome => _outcome.stream;
  @override
  Stream<Map<String, dynamic>> get driverAssignment => _assignment.stream;
  @override
  Stream<Map<String, dynamic>> get rideStateChanged => _rideState.stream;

  @override
  void subscribeRide(String rideId) => rideSubscriptions.add(rideId);
  @override
  void unsubscribeRide(String rideId) => rideSubscriptions.remove(rideId);

  @override
  Future<void> connect() async {}
  @override
  void disconnect() {}

  @override
  void sendOfferResponse({required String offerId, required bool accept}) {
    sent.add((event: 'ride_offer_response', data: {'offerId': offerId, 'accept': accept}));
  }

  @override
  void requestAssignmentSnapshot() {
    snapshotRequests += 1;
  }

  @override
  void sendPickupConfirmed({required String rideId, required int sequenceIndex}) {
    sent.add((event: 'stop:pickup_confirmed', data: {'rideId': rideId, 'sequenceIndex': sequenceIndex}));
  }

  @override
  void sendDropConfirmed({required String rideId, required int sequenceIndex}) {
    sent.add((event: 'stop:drop_confirmed', data: {'rideId': rideId, 'sequenceIndex': sequenceIndex}));
  }

  @override
  Future<void> dispose() async {
    await Future.wait([
      _rideOffer.close(), _rideOfferAccepted.close(), _rideOfferRevoked.close(),
      _stopPickup.close(), _stopDrop.close(), _rideCompleted.close(),
      _driverState.close(), _outcome.close(), _assignment.close(), _rideState.close(),
    ]);
  }

  void emitRideOffer(Map<String, dynamic> p) => _rideOffer.add(p);
  void emitAccepted(Map<String, dynamic> p) => _rideOfferAccepted.add(p);
  void emitRevoked(Map<String, dynamic> p) => _rideOfferRevoked.add(p);
  void emitStopPickup(Map<String, dynamic> p) => _stopPickup.add(p);
  void emitStopDrop(Map<String, dynamic> p) => _stopDrop.add(p);
  void emitRideCompleted(Map<String, dynamic> p) => _rideCompleted.add(p);
  void emitDriverState(Map<String, dynamic> p) => _driverState.add(p);
  void emitOutcome(Map<String, dynamic> p) => _outcome.add(p);
  void emitAssignment(Map<String, dynamic> p) => _assignment.add(p);
  void emitRideState(Map<String, dynamic> p) => _rideState.add(p);
}
