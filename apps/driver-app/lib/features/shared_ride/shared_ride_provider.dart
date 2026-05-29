import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'shared_ride_models.dart';

/// Thin transport interface so the provider can run without a real
/// `socket_io_client` instance in widget tests.
abstract class StopConfirmSender {
  void sendPickupConfirmed({required String rideId, required int sequenceIndex});
  void sendDropConfirmed({required String rideId, required int sequenceIndex});
}

class SharedRideNotifier extends StateNotifier<SharedRideState> {
  SharedRideNotifier(this._sender) : super(SharedRideState.empty);

  final StopConfirmSender _sender;

  /// Apply an incoming `ride_offer` event payload for a shared ride.
  void applyOffer(SharedRideOffer offer) {
    final sorted = [...offer.stops]
      ..sort((a, b) => a.sequenceIndex.compareTo(b.sequenceIndex));
    state = SharedRideState(
      sharedRideId: offer.sharedRideId,
      stops: sorted
          .map((s) => StopState(stop: s, status: StopStatus.pending))
          .toList(),
      currentStopIndex: 0,
      completed: false,
    );
  }

  /// Hydrate state from `GET /v1/rides/:id/stops` on WS reconnect.
  void hydrateFromServer({
    required String sharedRideId,
    required List<Map<String, dynamic>> stops,
  }) {
    final restored = stops.map((j) {
      final stop = SharedRideStop.fromOfferJson(j);
      final confirmed = (j['confirmed'] as bool?) ?? false;
      final at = j['confirmedAt'] as String?;
      return StopState(
        stop: stop,
        status: confirmed ? StopStatus.confirmed : StopStatus.pending,
        confirmedAt: at != null ? DateTime.tryParse(at) : null,
      );
    }).toList()
      ..sort((a, b) => a.stop.sequenceIndex.compareTo(b.stop.sequenceIndex));

    final firstPendingIndex = restored.indexWhere(
      (s) => s.status == StopStatus.pending,
    );
    final allDone = firstPendingIndex == -1;
    state = SharedRideState(
      sharedRideId: sharedRideId,
      stops: restored,
      currentStopIndex: allDone ? restored.length : firstPendingIndex,
      completed: allDone,
    );
  }

  /// Send the WS confirmation for the current pending stop.
  bool confirmCurrentStop() {
    if (state.completed) return false;
    final current = state.currentStop;
    final rideId = state.sharedRideId;
    if (current == null || rideId == null) return false;
    if (current.status != StopStatus.pending) return false;

    final idx = current.stop.sequenceIndex;
    if (current.stop.type == StopType.pickup) {
      _sender.sendPickupConfirmed(rideId: rideId, sequenceIndex: idx);
    } else {
      _sender.sendDropConfirmed(rideId: rideId, sequenceIndex: idx);
    }
    return true;
  }

  /// Apply the server-echo for either `stop:pickup_confirmed` or
  /// `stop:drop_confirmed`. Advances the cursor and flips `completed` when the
  /// server signals it.
  void applyServerEcho({
    required String rideId,
    required int sequenceIndex,
    required DateTime confirmedAt,
    required bool rideCompleted,
  }) {
    if (state.sharedRideId != rideId) return;
    final stops = state.stops;
    final idx = stops.indexWhere((s) => s.stop.sequenceIndex == sequenceIndex);
    if (idx < 0) return;
    if (stops[idx].status == StopStatus.confirmed) return;

    final updated = [
      for (var i = 0; i < stops.length; i += 1)
        if (i == idx)
          stops[i].copyWith(
            status: StopStatus.confirmed,
            confirmedAt: confirmedAt,
          )
        else
          stops[i],
    ];

    final nextPending = updated.indexWhere((s) => s.status == StopStatus.pending);
    final nextIndex = nextPending == -1 ? updated.length : nextPending;
    state = state.copyWith(
      stops: updated,
      currentStopIndex: nextIndex,
      completed: rideCompleted || nextPending == -1,
    );
  }

  void reset() {
    state = SharedRideState.empty;
  }
}

final sharedRideSenderProvider = Provider<StopConfirmSender>((ref) {
  throw UnimplementedError(
    'Override sharedRideSenderProvider in main.dart with a real socket sender.',
  );
});

final sharedRideProvider =
    StateNotifierProvider<SharedRideNotifier, SharedRideState>((ref) {
  return SharedRideNotifier(ref.watch(sharedRideSenderProvider));
});
