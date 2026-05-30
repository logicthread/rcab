import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../di/providers.dart';
import 'ride_models.dart';

/// Transport seam for the solo ride lifecycle so the notifier can run without
/// a real Dio in tests.
abstract class RideService {
  Future<RideDetail> getRide(String rideId);

  /// Advance the ride; returns the new status string from the server.
  Future<String> advance(String rideId, String event);
}

class HttpRideService implements RideService {
  HttpRideService(this._dio);

  final Dio _dio;

  @override
  Future<RideDetail> getRide(String rideId) async {
    final res = await _dio.get<Map<String, dynamic>>('/v1/rides/$rideId');
    return RideDetail.fromJson(res.data!);
  }

  @override
  Future<String> advance(String rideId, String event) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/v1/rides/$rideId/state',
      data: {'event': event},
    );
    return res.data!['status'] as String;
  }
}

class RideNotifier extends StateNotifier<RideState> {
  RideNotifier(this._service, String rideId) : super(RideState.initial(rideId));

  final RideService _service;

  /// Hydrate from `GET /v1/rides/:id` (mount + reconnect-restore). On failure
  /// we still flip `loaded` so the screen leaves its spinner.
  Future<void> load() async {
    try {
      final d = await _service.getRide(state.rideId);
      state = state.copyWith(
        status: RideStatus.parse(d.status),
        originLat: d.originLat,
        originLng: d.originLng,
        destLat: d.destLat,
        destLng: d.destLng,
        loaded: true,
      );
    } catch (_) {
      state = state.copyWith(loaded: true);
    }
  }

  /// Fire a forward transition. The server response is authoritative; an error
  /// (e.g. 409 because the state moved) re-syncs from the server.
  Future<void> advance(String event) async {
    if (state.busy) return;
    state = state.copyWith(busy: true);
    try {
      final newStatus = await _service.advance(state.rideId, event);
      state = state.copyWith(status: RideStatus.parse(newStatus), busy: false);
    } catch (_) {
      state = state.copyWith(busy: false);
      await load();
    }
  }
}

final rideServiceProvider = Provider<RideService>(
  (ref) => HttpRideService(ref.watch(apiClientProvider)),
);

final rideProvider =
    StateNotifierProvider.autoDispose.family<RideNotifier, RideState, String>(
  (ref, rideId) => RideNotifier(ref.watch(rideServiceProvider), rideId),
);

/// Launches an external maps app for turn-by-turn navigation. Seam so widget
/// tests can capture the URI instead of hitting the `url_launcher` plugin.
typedef MapsLauncher = Future<bool> Function(Uri uri);

final mapsLauncherProvider = Provider<MapsLauncher>(
  (ref) => (uri) => launchUrl(uri, mode: LaunchMode.externalApplication),
);
