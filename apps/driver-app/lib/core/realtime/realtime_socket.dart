import 'dart:async';

import 'package:socket_io_client/socket_io_client.dart' as io;

import '../auth/token_store.dart';
import 'offer_outcome.dart';
import '../../features/offer/offer_models.dart';
import '../../features/shared_ride/shared_ride_provider.dart';

/// Test-friendly seam for the realtime socket. Production code uses
/// [RealtimeSocket]; widget/unit tests use a fake implementing this interface.
abstract class IRealtimeSocket implements StopConfirmSender, OfferResponseSender {
  Stream<Map<String, dynamic>> get rideOffer;
  Stream<Map<String, dynamic>> get rideOfferAccepted;
  Stream<Map<String, dynamic>> get rideOfferRevoked;
  Stream<Map<String, dynamic>> get stopPickupConfirmed;
  Stream<Map<String, dynamic>> get stopDropConfirmed;
  Stream<Map<String, dynamic>> get rideCompleted;
  Stream<Map<String, dynamic>> get driverState;

  /// Explicit per-offer outcomes (R09): server `ride_offer_outcome` events AND
  /// the normalised `ride_offer_response` ack, in one JSON shape
  /// (see [OfferOutcome]).
  Stream<Map<String, dynamic>> get rideOfferOutcome;

  /// `driver:assignment` snapshots (`{driverId, assignment|null}`), sent by the
  /// server on every (re)connect and in answer to [requestAssignmentSnapshot].
  Stream<Map<String, dynamic>> get driverAssignment;

  /// Solo ride status changes for rides followed with [subscribeRide]:
  /// server `ride_state_changed` events (`{rideId, state, by}`) plus the
  /// subscribe snapshot normalised to the same shape.
  Stream<Map<String, dynamic>> get rideStateChanged;

  /// Follow a solo ride (`ride:subscribe`, re-sent on every (re)connect) so a
  /// passenger cancel or a server-side transition reaches the ride screen live.
  void subscribeRide(String rideId);

  /// Stop re-subscribing [rideId] on reconnect.
  void unsubscribeRide(String rideId);

  /// Ask the server for the committed assignment (`driver:sync`). Used after
  /// listeners attach (cold start) and when an accept ack went missing.
  void requestAssignmentSnapshot();

  Future<void> connect();
  void disconnect();
  Future<void> dispose();
}

/// Standalone Socket.IO connection used by shared-ride features.
///
/// Phase-0 scope: a second socket alongside `DriverStateNotifier._socket`.
/// Consolidating into a single shared transport is deferred (no story yet).
class RealtimeSocket implements IRealtimeSocket {
  RealtimeSocket({required this.apiBaseUrl, required this.tokenStore});

  final String apiBaseUrl;
  final TokenStore tokenStore;

  io.Socket? _socket;

  final _rideOfferCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _rideOfferAcceptedCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _rideOfferRevokedCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _stopPickupCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _stopDropCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _rideCompletedCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _driverStateCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _offerOutcomeCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _driverAssignmentCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _rideStateCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final Set<String> _rideSubs = <String>{};

  @override
  Stream<Map<String, dynamic>> get rideOffer => _rideOfferCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get rideOfferAccepted => _rideOfferAcceptedCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get rideOfferRevoked => _rideOfferRevokedCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get stopPickupConfirmed => _stopPickupCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get stopDropConfirmed => _stopDropCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get rideCompleted => _rideCompletedCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get driverState => _driverStateCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get rideOfferOutcome => _offerOutcomeCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get driverAssignment => _driverAssignmentCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get rideStateChanged => _rideStateCtrl.stream;

  Future<void>? _connecting;

  /// Idempotent: concurrent callers (the offer and shared-ride controllers
  /// start together) share one in-flight connect, so exactly one socket
  /// exists and no event is delivered twice.
  @override
  Future<void> connect() {
    if (_socket != null) return Future.value();
    return _connecting ??= _connect().whenComplete(() => _connecting = null);
  }

  Future<void> _connect() async {
    final jwt = await tokenStore.getJwt();
    if (jwt == null || _socket != null) return;

    _socket = io.io(
      apiBaseUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': jwt})
          .disableAutoConnect()
          .build(),
    )
      ..on('ride_offer', (raw) {
        final map = _asMap(raw);
        if (map != null) _rideOfferCtrl.add(map);
      })
      ..on('ride_offer_accepted', (raw) {
        final map = _asMap(raw);
        if (map != null) _rideOfferAcceptedCtrl.add(map);
      })
      ..on('ride_offer_revoked', (raw) {
        final map = _asMap(raw);
        if (map != null) _rideOfferRevokedCtrl.add(map);
      })
      ..on('stop:pickup_confirmed', (raw) {
        final map = _asMap(raw);
        if (map != null) _stopPickupCtrl.add(map);
      })
      ..on('stop:drop_confirmed', (raw) {
        final map = _asMap(raw);
        if (map != null) _stopDropCtrl.add(map);
      })
      ..on('ride:completed', (raw) {
        final map = _asMap(raw);
        if (map != null) _rideCompletedCtrl.add(map);
      })
      ..on('driver_state', (raw) {
        final map = _asMap(raw);
        if (map != null) _driverStateCtrl.add(map);
      })
      ..on('ride_offer_outcome', (raw) {
        final map = _asMap(raw);
        if (map != null) _add(_offerOutcomeCtrl, map);
      })
      // Sent by the server on every (re)connect: the committed assignment.
      ..on('driver:assignment', (raw) {
        final map = _asMap(raw);
        if (map != null) _add(_driverAssignmentCtrl, map);
      })
      ..on('ride_state_changed', (raw) {
        final map = _asMap(raw);
        if (map != null) _add(_rideStateCtrl, map);
      })
      // Rooms do not survive a reconnect: follow every tracked ride again.
      ..onConnect((_) {
        for (final id in _rideSubs) {
          _emitRideSubscribe(id);
        }
      })
      ..connect();
  }

  @override
  void disconnect() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }

  /// Sends the response with an ack. The ack (the server's authoritative
  /// accept / decline result) is normalised into [rideOfferOutcome], so a
  /// refused accept surfaces immediately even if no event follows.
  @override
  void sendOfferResponse({required String offerId, required bool accept}) {
    _socket?.emitWithAck(
      'ride_offer_response',
      {'offerId': offerId, 'accept': accept},
      ack: (dynamic data) {
        final json = OfferOutcome.jsonFromAck(offerId: offerId, accept: accept, ack: _asMap(data));
        if (json != null) _add(_offerOutcomeCtrl, json);
      },
    );
  }

  @override
  void subscribeRide(String rideId) {
    if (_rideSubs.add(rideId) && (_socket?.connected ?? false)) _emitRideSubscribe(rideId);
  }

  @override
  void unsubscribeRide(String rideId) => _rideSubs.remove(rideId);

  void _emitRideSubscribe(String rideId) {
    _socket?.emitWithAck('ride:subscribe', {'rideId': rideId}, ack: (dynamic data) {
      final ack = _asMap(data);
      final snap = ack == null ? null : _asMap(ack['snapshot']);
      if (ack?['ok'] == true && snap != null && snap['status'] is String) {
        _add(_rideStateCtrl, {'rideId': rideId, 'state': snap['status'], 'by': 'snapshot'});
      }
    });
  }

  @override
  void requestAssignmentSnapshot() {
    _socket?.emitWithAck('driver:sync', null, ack: (dynamic data) {
      final map = _asMap(data);
      if (map != null && map.containsKey('assignment')) _add(_driverAssignmentCtrl, map);
    });
  }

  void _add(StreamController<Map<String, dynamic>> ctrl, Map<String, dynamic> event) {
    if (!ctrl.isClosed) ctrl.add(event);
  }

  @override
  void sendPickupConfirmed({required String rideId, required int sequenceIndex}) {
    _socket?.emit('stop:pickup_confirmed', {
      'rideId': rideId,
      'sequenceIndex': sequenceIndex,
    });
  }

  @override
  void sendDropConfirmed({required String rideId, required int sequenceIndex}) {
    _socket?.emit('stop:drop_confirmed', {
      'rideId': rideId,
      'sequenceIndex': sequenceIndex,
    });
  }

  @override
  Future<void> dispose() async {
    disconnect();
    await Future.wait([
      _rideOfferCtrl.close(),
      _rideOfferAcceptedCtrl.close(),
      _rideOfferRevokedCtrl.close(),
      _stopPickupCtrl.close(),
      _stopDropCtrl.close(),
      _rideCompletedCtrl.close(),
      _driverStateCtrl.close(),
      _offerOutcomeCtrl.close(),
      _driverAssignmentCtrl.close(),
      _rideStateCtrl.close(),
    ]);
  }

  Map<String, dynamic>? _asMap(dynamic raw) {
    if (raw is Map<String, dynamic>) return raw;
    if (raw is Map) {
      return raw.map((k, v) => MapEntry(k.toString(), v));
    }
    return null;
  }
}
