import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/realtime/driver_assignment.dart';
import '../../core/realtime/offer_outcome.dart';
import '../../core/realtime/realtime_socket.dart';
import '../../di/providers.dart';
import 'shared_ride_models.dart';
import 'shared_ride_provider.dart';
import '../../core/config/policy.dart';

typedef NavigateFn = void Function(String location);

/// Bridges the realtime socket to [sharedRideProvider] and owns shared-ride
/// navigation (R09 / F10):
///
/// - a shared `ride_offer` opens `/shared-ride/:id`, which shows the proposed
///   itinerary with Accept / Decline — NOT the stop controls;
/// - the stop screen goes live only on the server's `assigned` outcome (ack or
///   `ride_offer_outcome`) or a `driver:assignment` snapshot;
/// - `lost` / `expired` / `revoked` / `rejected` and countdown expiry return
///   the driver to `/home`;
/// - every (re)connect's `driver:assignment` snapshot (and an explicit
///   `driver:sync` after start-up or a missing accept ack) restores — or
///   clears — the active shared trip from Postgres.
class SharedRideController {
  SharedRideController({
    required this.container,
    GoRouter? router,
    NavigateFn? navigate,
    this.tickInterval = DriverPolicy.offerCountdownTick,
    this.ackTimeout = DriverPolicy.sharedAcceptAckTimeout,
  })  : _navigate = navigate ?? ((loc) => router?.go(loc)),
        assert(router != null || navigate != null,
            'Provide either router or navigate callback');

  final ProviderContainer container;
  final NavigateFn _navigate;

  /// Countdown granularity (injectable for tests).
  final Duration tickInterval;

  /// How long to wait for the accept ack before asking for a snapshot.
  final Duration ackTimeout;

  final List<StreamSubscription<dynamic>> _subs = [];
  ProviderSubscription<SharedRideState>? _phaseSub;
  Timer? _ticker;
  Timer? _ackTimer;
  IRealtimeSocket? _socket;

  /// Set when an accept ack said `unavailable`: the server did not decide, so
  /// the next `driver:assignment` snapshot does (assigned → stop screen,
  /// none → home).
  bool _awaitingVerdict = false;

  Future<void> start() async {
    final IRealtimeSocket socket = container.read(realtimeSocketProvider);
    _socket = socket;
    await socket.connect();
    _subscribe(socket);
    _phaseSub = container.listen<SharedRideState>(
      sharedRideProvider,
      (prev, next) => _onPhase(prev?.phase, next.phase),
    );
    // Listeners attach after the connect-time snapshot may already have been
    // emitted: ask for it explicitly (cold start restore).
    socket.requestAssignmentSnapshot();
  }

  void stop() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    _subs.clear();
    _phaseSub?.close();
    _phaseSub = null;
    _cancelTicker();
    _cancelAckTimer();
  }

  SharedRideNotifier get _notifier => container.read(sharedRideProvider.notifier);

  void _subscribe(IRealtimeSocket socket) {
    _subs.add(socket.rideOffer.listen(_onRideOffer));
    _subs.add(socket.rideOfferOutcome.listen(_onOutcome));
    _subs.add(socket.driverAssignment.listen(_onAssignment));
    _subs.add(socket.stopPickupConfirmed.listen(_onStopEcho));
    _subs.add(socket.stopDropConfirmed.listen(_onStopEcho));
    _subs.add(socket.rideCompleted.listen(_onRideCompleted));
  }

  void _onRideOffer(Map<String, dynamic> payload) {
    final offer = SharedRideOffer.tryFromRideOfferJson(payload);
    if (offer == null) return; // Solo offer — OfferController handles it.
    final before = container.read(sharedRideProvider);
    _notifier.applyOffer(offer);
    final after = container.read(sharedRideProvider);
    if (identical(before, after) || after.phase != SharedRidePhase.offered) return;
    _navigate('/shared-ride/${offer.sharedRideId}');
    _startTicker();
  }

  void _onOutcome(Map<String, dynamic> payload) {
    final outcome = OfferOutcome.fromJson(payload);
    if (outcome == null) return;
    final wasOnTrip = container.read(sharedRideProvider).sharedRideId;
    if (outcome.kind == OfferOutcomeKind.unknown) {
      // Undecided accept: keep the offer screen waiting and ask the server
      // what it committed instead of abandoning an accept that may have won.
      final s = container.read(sharedRideProvider);
      if (s.phase == SharedRidePhase.accepting && s.offerId == outcome.offerId) {
        _awaitingVerdict = true;
        _socket?.requestAssignmentSnapshot();
      }
      return;
    }
    if (!_notifier.applyOutcome(outcome)) return;
    final state = container.read(sharedRideProvider);
    if (state.isAssigned) {
      _cancelTicker();
      _cancelAckTimer();
      if (wasOnTrip != state.sharedRideId) _navigate('/shared-ride/${state.sharedRideId}');
    } else if (state.isTerminalOutcome) {
      _cancelTicker();
      _cancelAckTimer();
      _notifier.reset();
      _navigate('/home');
    }
  }

  void _onAssignment(Map<String, dynamic> payload) {
    final snapshot = DriverAssignmentSnapshot.fromJson(payload);
    if (snapshot == null) return;
    if (_awaitingVerdict &&
        snapshot.assignment == null &&
        container.read(sharedRideProvider).phase == SharedRidePhase.accepting) {
      // The server holds no assignment: the undecided accept did not commit.
      _awaitingVerdict = false;
      _cancelTicker();
      _cancelAckTimer();
      _notifier.resolveUndecidedAccept();
      _navigate('/home');
      return;
    }
    final change = _notifier.applyAssignment(snapshot.assignment);
    if (change == AssignmentChange.restored) _awaitingVerdict = false;
    switch (change) {
      case AssignmentChange.restored:
        _cancelTicker();
        _cancelAckTimer();
        _navigate('/shared-ride/${snapshot.assignment!.tripId}');
        break;
      case AssignmentChange.released:
        _navigate('/home');
        break;
      case AssignmentChange.refreshed:
      case AssignmentChange.none:
        break;
    }
  }

  void _onStopEcho(Map<String, dynamic> payload) {
    final rideId = payload['rideId'] as String?;
    final seq = payload['sequenceIndex'];
    final confirmedAtRaw = payload['confirmedAt'] as String?;
    final rideCompleted = (payload['rideCompleted'] as bool?) ?? false;
    if (rideId == null || seq is! int || confirmedAtRaw == null) return;
    final at = DateTime.tryParse(confirmedAtRaw);
    if (at == null) return;
    _notifier.applyServerEcho(
      rideId: rideId,
      sequenceIndex: seq,
      confirmedAt: at,
      rideCompleted: rideCompleted,
      version: (payload['version'] as num?)?.toInt(),
    );
  }

  void _onRideCompleted(Map<String, dynamic> payload) {
    final rideId = payload['rideId'] as String?;
    if (rideId == null) return;
    final current = container.read(sharedRideProvider);
    if (current.sharedRideId != rideId || current.completed || !current.isAssigned) return;
    final lastIdx = current.stops.length - 1;
    if (lastIdx < 0) return;
    _notifier.applyServerEcho(
      rideId: rideId,
      sequenceIndex: lastIdx,
      confirmedAt: DateTime.tryParse(payload['completedAt'] as String? ?? '') ?? DateTime.now(),
      rideCompleted: true,
    );
  }

  void _onPhase(SharedRidePhase? prev, SharedRidePhase next) {
    if (next == SharedRidePhase.accepting && prev != SharedRidePhase.accepting) {
      _startAckTimer();
    } else if (next != SharedRidePhase.accepting) {
      _cancelAckTimer();
    }
  }

  void _startAckTimer() {
    _cancelAckTimer();
    _ackTimer = Timer(ackTimeout, () {
      _ackTimer = null;
      if (container.read(sharedRideProvider).phase != SharedRidePhase.accepting) return;
      // Lost ack: the snapshot tells us whether the accept committed.
      _awaitingVerdict = false;
      _socket?.requestAssignmentSnapshot();
      _notifier.ackTimedOut();
      if (container.read(sharedRideProvider).phase == SharedRidePhase.expired) {
        _cancelTicker();
        _notifier.reset();
        _navigate('/home');
      }
    });
  }

  void _cancelAckTimer() {
    _ackTimer?.cancel();
    _ackTimer = null;
  }

  void _startTicker() {
    _cancelTicker();
    _ticker = Timer.periodic(tickInterval, (_) {
      _notifier.tick();
      final s = container.read(sharedRideProvider);
      if (s.phase == SharedRidePhase.expired) {
        _cancelTicker();
        _notifier.reset();
        _navigate('/home');
      } else if (!s.isOffer) {
        _cancelTicker();
      }
    });
  }

  void _cancelTicker() {
    _ticker?.cancel();
    _ticker = null;
  }
}

final sharedRideControllerProvider = Provider<SharedRideController>((ref) {
  throw UnimplementedError('Provide a router when overriding sharedRideControllerProvider.');
});
