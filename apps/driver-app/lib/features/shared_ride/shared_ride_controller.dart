import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/realtime/realtime_socket.dart';
import '../../di/providers.dart';
import 'shared_ride_models.dart';
import 'shared_ride_provider.dart';

typedef NavigateFn = void Function(String location);

/// Listens to the realtime socket and routes shared-ride lifecycle events
/// (`ride_offer`, `stop:pickup_confirmed`, `stop:drop_confirmed`, `ride:completed`)
/// into the `sharedRideProvider`. On reconnect via `driver_state` it hydrates
/// state from `GET /v1/rides/:id/stops`.
class SharedRideController {
  SharedRideController({
    required this.container,
    GoRouter? router,
    NavigateFn? navigate,
    Dio? dio,
  })  : _navigate = navigate ?? ((loc) => router?.go(loc)),
        _dio = dio,
        assert(router != null || navigate != null,
            'Provide either router or navigate callback');

  final ProviderContainer container;
  final NavigateFn _navigate;
  final Dio? _dio;

  final List<StreamSubscription<dynamic>> _subs = [];

  Future<void> start() async {
    final IRealtimeSocket socket = container.read(realtimeSocketProvider);
    await socket.connect();
    _subscribe(socket);
  }

  void stop() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    _subs.clear();
  }

  void _subscribe(IRealtimeSocket socket) {
    _subs.add(socket.rideOffer.listen(_onRideOffer));
    _subs.add(socket.stopPickupConfirmed.listen(_onStopEcho));
    _subs.add(socket.stopDropConfirmed.listen(_onStopEcho));
    _subs.add(socket.rideCompleted.listen(_onRideCompleted));
    _subs.add(socket.driverState.listen(_onDriverState));
  }

  void _onRideOffer(Map<String, dynamic> payload) {
    final offer = SharedRideOffer.tryFromRideOfferJson(payload);
    if (offer == null) return; // Solo offer — handled elsewhere.
    container.read(sharedRideProvider.notifier).applyOffer(offer);
    _navigate('/shared-ride/${offer.sharedRideId}');
  }

  void _onStopEcho(Map<String, dynamic> payload) {
    final rideId = payload['rideId'] as String?;
    final seq = payload['sequenceIndex'];
    final confirmedAtRaw = payload['confirmedAt'] as String?;
    final rideCompleted = (payload['rideCompleted'] as bool?) ?? false;
    if (rideId == null || seq is! int || confirmedAtRaw == null) return;
    final at = DateTime.tryParse(confirmedAtRaw);
    if (at == null) return;
    container.read(sharedRideProvider.notifier).applyServerEcho(
          rideId: rideId,
          sequenceIndex: seq,
          confirmedAt: at,
          rideCompleted: rideCompleted,
        );
  }

  void _onRideCompleted(Map<String, dynamic> payload) {
    final rideId = payload['rideId'] as String?;
    if (rideId == null) return;
    final current = container.read(sharedRideProvider);
    if (current.sharedRideId != rideId || current.completed) return;
    final lastIdx = current.stops.length - 1;
    if (lastIdx < 0) return;
    container.read(sharedRideProvider.notifier).applyServerEcho(
          rideId: rideId,
          sequenceIndex: lastIdx,
          confirmedAt: DateTime.tryParse(payload['completedAt'] as String? ?? '') ?? DateTime.now(),
          rideCompleted: true,
        );
  }

  Future<void> _onDriverState(Map<String, dynamic> payload) async {
    final rideId = payload['current_ride_id'] as String?;
    if (rideId == null) return;
    final current = container.read(sharedRideProvider);
    if (current.sharedRideId == rideId && current.stops.isNotEmpty) return;
    final stops = await _fetchStops(rideId);
    if (stops == null) return;
    container.read(sharedRideProvider.notifier).hydrateFromServer(
          sharedRideId: rideId,
          stops: stops,
        );
    _navigate('/shared-ride/$rideId');
  }

  Future<List<Map<String, dynamic>>?> _fetchStops(String rideId) async {
    final Dio dio = _dio ?? container.read(apiClientProvider);
    try {
      final res = await dio.get<Map<String, dynamic>>('/v1/rides/$rideId/stops');
      final raw = res.data?['stops'];
      if (raw is! List) return null;
      return raw.whereType<Map>().map((m) => m.map((k, v) => MapEntry(k.toString(), v))).toList();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('SharedRideController: fetchStops failed for $rideId — $e');
      }
      return null;
    }
  }
}

final sharedRideControllerProvider = Provider<SharedRideController>((ref) {
  throw UnimplementedError('Provide a router when overriding sharedRideControllerProvider.');
});
