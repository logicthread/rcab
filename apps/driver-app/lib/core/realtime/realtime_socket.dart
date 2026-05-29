import 'dart:async';

import 'package:socket_io_client/socket_io_client.dart' as io;

import '../auth/token_store.dart';
import '../../features/shared_ride/shared_ride_provider.dart';

/// Test-friendly seam for the realtime socket. Production code uses
/// [RealtimeSocket]; widget/unit tests use a fake implementing this interface.
abstract class IRealtimeSocket implements StopConfirmSender {
  Stream<Map<String, dynamic>> get rideOffer;
  Stream<Map<String, dynamic>> get stopPickupConfirmed;
  Stream<Map<String, dynamic>> get stopDropConfirmed;
  Stream<Map<String, dynamic>> get rideCompleted;
  Stream<Map<String, dynamic>> get driverState;

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
  final _stopPickupCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _stopDropCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _rideCompletedCtrl = StreamController<Map<String, dynamic>>.broadcast();
  final _driverStateCtrl = StreamController<Map<String, dynamic>>.broadcast();

  @override
  Stream<Map<String, dynamic>> get rideOffer => _rideOfferCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get stopPickupConfirmed => _stopPickupCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get stopDropConfirmed => _stopDropCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get rideCompleted => _rideCompletedCtrl.stream;
  @override
  Stream<Map<String, dynamic>> get driverState => _driverStateCtrl.stream;

  @override
  Future<void> connect() async {
    if (_socket != null) return;
    final jwt = await tokenStore.getJwt();
    if (jwt == null) return;

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
      ..connect();
  }

  @override
  void disconnect() {
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
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
      _stopPickupCtrl.close(),
      _stopDropCtrl.close(),
      _rideCompletedCtrl.close(),
      _driverStateCtrl.close(),
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
