import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/realtime/driver_assignment.dart';
import '../../core/realtime/offer_outcome.dart';
import '../offer/offer_models.dart';
import '../offer/offer_provider.dart';
import 'shared_ride_models.dart';

/// Thin transport interface so the provider can run without a real
/// `socket_io_client` instance in widget tests.
abstract class StopConfirmSender {
  void sendPickupConfirmed({required String rideId, required int sequenceIndex});
  void sendDropConfirmed({required String rideId, required int sequenceIndex});
}

/// Shared-trip state machine on the driver (R09 / F10):
///
/// `none → offered → accepting → assigned` on a committed server outcome,
/// or `offered|accepting → lost | expired | revoked | rejected`.
/// Receiving an offer never enables pickup / dropoff commands; only
/// [SharedRidePhase.assigned] does, and it is entered only from the server's
/// assigned outcome or its `driver:assignment` snapshot.
class SharedRideNotifier extends StateNotifier<SharedRideState> {
  SharedRideNotifier(this._sender, {OfferResponseSender? offerSender})
      : _offerSender = offerSender,
        super(SharedRideState.empty);

  final StopConfirmSender _sender;
  final OfferResponseSender? _offerSender;

  // Highest server `state_version` applied for [_versionTripId] (from a
  // snapshot or a stop-confirm echo). Survives [reset] on purpose: a stale
  // snapshot arriving after the driver left a finished trip must not bring it
  // back. Snapshots / echoes below it are dropped.
  String? _versionTripId;
  int _appliedVersion = 0;

  // The last trip this notifier saw complete (kept across [reset]).
  String? _completedTripId;

  void _noteVersion(String tripId, int? version) {
    if (version == null) return;
    if (_versionTripId != tripId) {
      _versionTripId = tripId;
      _appliedVersion = version;
    } else if (version > _appliedVersion) {
      _appliedVersion = version;
    }
  }

  /// True when [version] is older than what was already applied for the trip.
  bool _isOlder(String tripId, int? version) =>
      version != null && _versionTripId == tripId && version < _appliedVersion;

  /// True for a snapshot that must not rewind a trip already completed locally
  /// (same trip, version not newer than what completed it).
  bool _revertsCompleted(String tripId, int version) =>
      _completedTripId == tripId && _versionTripId == tripId && version <= _appliedVersion;

  /// Apply an incoming shared `ride_offer`: show the proposed itinerary and
  /// start ringing. Ignored while a committed trip is in progress (the server
  /// does not offer a busy driver; a stray event must not replace the trip).
  void applyOffer(SharedRideOffer offer) {
    if (state.isAssigned && !state.completed) return;
    final sorted = [...offer.stops]
      ..sort((a, b) => a.sequenceIndex.compareTo(b.sequenceIndex));
    state = SharedRideState(
      sharedRideId: offer.sharedRideId,
      stops: sorted
          .map((s) => StopState(stop: s, status: StopStatus.pending))
          .toList(),
      currentStopIndex: 0,
      completed: false,
      phase: SharedRidePhase.offered,
      offerId: offer.offerId,
      passengerCount: offer.passengerCount,
      secondsLeft: (offer.ttlMs / 1000).ceil(),
    );
  }

  /// One countdown step while ringing; the advisory deadline flips to
  /// `expired` (the server's DB clock stays authoritative for an accept).
  void tick() {
    if (state.phase != SharedRidePhase.offered) return;
    final next = state.secondsLeft - 1;
    state = next <= 0
        ? state.copyWith(phase: SharedRidePhase.expired, secondsLeft: 0)
        : state.copyWith(secondsLeft: next);
  }

  /// Driver tapped Accept. Sends the response and waits for the verdict.
  bool accept() {
    final offerId = state.offerId;
    if (state.phase != SharedRidePhase.offered || offerId == null) return false;
    final sender = _offerSender;
    if (sender == null) return false;
    sender.sendOfferResponse(offerId: offerId, accept: true);
    state = state.copyWith(phase: SharedRidePhase.accepting);
    return true;
  }

  /// Driver tapped Decline: release the offer server-side and dismiss.
  void decline() {
    final offerId = state.offerId;
    if (state.isOffer && offerId != null) {
      _offerSender?.sendOfferResponse(offerId: offerId, accept: false);
    }
    if (state.isOffer || state.isTerminalOutcome) state = SharedRideState.empty;
  }

  /// Apply an explicit outcome for this driver's offer (ack or event). Returns
  /// true when the phase changed. Duplicates (ack + event) are no-ops, and a
  /// loss can never undo a committed assignment.
  bool applyOutcome(OfferOutcome outcome) {
    final ownOffer = state.offerId != null && outcome.offerId == state.offerId;
    if (outcome.kind == OfferOutcomeKind.assigned) {
      if (!outcome.isShared && outcome.tripKind != null) return false;
      final matches = ownOffer ||
          (outcome.tripId != null && outcome.tripId == state.sharedRideId && state.isOffer);
      if (!matches) {
        // Lost-ack recovery: the event may arrive after state was reset; the
        // assignment payload (when present) is still authoritative.
        final a = DriverAssignment.fromJson(outcome.assignment);
        if (a != null && a.isShared && a.offerId == outcome.offerId) {
          return applyAssignment(a) == AssignmentChange.restored;
        }
        return false;
      }
      final a = DriverAssignment.fromJson(outcome.assignment);
      if (a != null && a.isShared && a.tripId == state.sharedRideId) {
        _hydrate(a);
        return true;
      }
      if (state.isAssigned) return false;
      state = state.copyWith(
        phase: SharedRidePhase.assigned,
        generation: outcome.generation,
        secondsLeft: 0,
      );
      return true;
    }
    if (!ownOffer) return false;
    switch (outcome.kind) {
      case OfferOutcomeKind.retry:
        if (state.phase != SharedRidePhase.accepting) return false;
        state = state.copyWith(phase: SharedRidePhase.offered);
        return true;
      case OfferOutcomeKind.declined:
      case OfferOutcomeKind.unknown:
        // `unknown` (server `unavailable`) is not a verdict: stay in
        // `accepting`; the controller asks for a snapshot which decides.
        return false;
      default:
        if (!state.isOffer) return false;
        state = state.copyWith(
          phase: _lossPhase(outcome.kind),
          outcomeReason: outcome.reason,
          secondsLeft: 0,
        );
        return true;
    }
  }

  /// The accept ack never arrived. The accept is replay-safe server-side, so
  /// fall back to ringing (or expired once the countdown ran out); a snapshot
  /// that shows the committed assignment moves us to `assigned` instead.
  void ackTimedOut() {
    if (state.phase != SharedRidePhase.accepting) return;
    state = state.copyWith(
      phase: state.secondsLeft > 0 ? SharedRidePhase.offered : SharedRidePhase.expired,
    );
  }

  /// An accept whose ack said `unavailable` was never decided by the server
  /// and a snapshot just reported no assignment: the accept did not commit.
  /// Returns true when an undecided `accepting` offer was dropped.
  bool resolveUndecidedAccept() {
    if (state.phase != SharedRidePhase.accepting) return false;
    state = SharedRideState.empty;
    return true;
  }

  /// Apply the authoritative `driver:assignment` snapshot. A snapshot older
  /// than what was already applied for the trip (stale / reordered delivery)
  /// is ignored, and a trip completed locally is never reopened by a snapshot
  /// of the same version or lower.
  AssignmentChange applyAssignment(DriverAssignment? a) {
    if (a == null) {
      // Released while we were away (completed / aborted / cancelled).
      if (state.isAssigned && !state.completed) {
        state = SharedRideState.empty;
        return AssignmentChange.released;
      }
      return AssignmentChange.none;
    }
    if (!a.isShared) return AssignmentChange.none;
    if (_isOlder(a.tripId, a.version) || _revertsCompleted(a.tripId, a.version)) {
      return AssignmentChange.none;
    }
    final wasSame = state.isAssigned && state.sharedRideId == a.tripId;
    _hydrate(a);
    return wasSame ? AssignmentChange.refreshed : AssignmentChange.restored;
  }

  void _hydrate(DriverAssignment a) {
    final restored = a.stops.map((j) {
      final stop = SharedRideStop.fromOfferJson(j);
      final confirmed = (j['confirmed'] as bool?) ?? false;
      final at = j['confirmedAt'] as String?;
      return StopState(
        stop: stop,
        status: confirmed ? StopStatus.confirmed : StopStatus.pending,
        confirmedAt: at != null ? DateTime.tryParse(at) : null,
      );
    }).toList()
      ..sort((x, y) => x.stop.sequenceIndex.compareTo(y.stop.sequenceIndex));
    final firstPending = restored.indexWhere((s) => s.status == StopStatus.pending);
    final passengers = <String>{for (final s in restored) s.stop.passengerId};
    _noteVersion(a.tripId, a.version);
    if (restored.isNotEmpty && firstPending == -1) _completedTripId = a.tripId;
    state = SharedRideState(
      sharedRideId: a.tripId,
      stops: restored,
      currentStopIndex: firstPending == -1 ? restored.length : firstPending,
      completed: restored.isNotEmpty && firstPending == -1,
      phase: SharedRidePhase.assigned,
      offerId: a.offerId,
      passengerCount: passengers.length,
      generation: a.generation,
    );
  }

  /// Hydrate state from a REST stops payload (legacy restore path).
  void hydrateFromServer({
    required String sharedRideId,
    required List<Map<String, dynamic>> stops,
  }) {
    _hydrate(DriverAssignment(
      tripKind: 'shared',
      tripId: sharedRideId,
      generation: 0,
      version: 0,
      stops: stops,
    ));
  }

  /// Send the WS confirmation for the current pending stop. Only a committed
  /// assignment may issue stop commands.
  bool confirmCurrentStop() {
    if (!state.isAssigned || state.completed) return false;
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
  /// server signals it. A server echo proves the server holds this driver's
  /// assignment, so it only applies to an assigned trip.
  void applyServerEcho({
    required String rideId,
    required int sequenceIndex,
    required DateTime confirmedAt,
    required bool rideCompleted,
    int? version,
  }) {
    if (state.sharedRideId != rideId || !state.isAssigned) return;
    // An echo older than an applied snapshot / echo is stale (its effect is
    // already included); a newer one raises the bar for later snapshots.
    if (_isOlder(rideId, version)) return;
    _noteVersion(rideId, version);
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
    if (rideCompleted || nextPending == -1) _completedTripId = rideId;
    state = state.copyWith(
      stops: updated,
      currentStopIndex: nextIndex,
      completed: rideCompleted || nextPending == -1,
    );
  }

  void reset() {
    state = SharedRideState.empty;
  }

  static SharedRidePhase _lossPhase(OfferOutcomeKind kind) {
    switch (kind) {
      case OfferOutcomeKind.lost:
        return SharedRidePhase.lost;
      case OfferOutcomeKind.expired:
        return SharedRidePhase.expired;
      case OfferOutcomeKind.revoked:
        return SharedRidePhase.revoked;
      default:
        return SharedRidePhase.rejected;
    }
  }
}

/// What a `driver:assignment` snapshot did to the shared-ride state.
enum AssignmentChange { none, restored, refreshed, released }

final sharedRideSenderProvider = Provider<StopConfirmSender>((ref) {
  throw UnimplementedError(
    'Override sharedRideSenderProvider in main.dart with a real socket sender.',
  );
});

final sharedRideProvider =
    StateNotifierProvider<SharedRideNotifier, SharedRideState>((ref) {
  return SharedRideNotifier(
    ref.watch(sharedRideSenderProvider),
    offerSender: ref.watch(offerResponseSenderProvider),
  );
});
