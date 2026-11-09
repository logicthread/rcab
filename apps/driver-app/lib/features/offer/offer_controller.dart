import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/realtime/driver_assignment.dart';
import '../../core/realtime/offer_outcome.dart';
import '../../di/providers.dart';
import '../home/driver_notice.dart';
import 'offer_models.dart';
import 'offer_provider.dart';
import '../../core/config/policy.dart';

typedef NavigateFn = void Function(String location);

/// Bridges the realtime socket to the solo-offer [offerProvider] and owns all
/// offer navigation: auto-opens `/offer/:id` on an incoming solo `ride_offer`,
/// routes to `/ride/:id` when the driver wins (`ride_offer_accepted`), and
/// returns to `/home` on revoke or TTL expiry. Mirrors `SharedRideController`;
/// shared offers (those carrying a `stops` array) are ignored here.
///
/// R09: the explicit `ride_offer_outcome` (and the normalised accept ack) is
/// applied alongside the legacy accepted / revoked events — duplicates are
/// no-ops — so a refused accept (busy, expired, …) is surfaced immediately.
/// A solo `driver:assignment` snapshot restores `/ride/:id` after a cold start
/// or a lost ack.
class OfferController {
  OfferController({
    required this.container,
    GoRouter? router,
    NavigateFn? navigate,
    this.tickInterval = DriverPolicy.offerCountdownTick,
  })  : _navigate = navigate ?? ((loc) => router?.go(loc)),
        assert(router != null || navigate != null,
            'Provide either router or navigate callback');

  final ProviderContainer container;
  final NavigateFn _navigate;

  /// Countdown granularity. Injectable so tests can drive expiry without
  /// waiting a real 12 seconds.
  final Duration tickInterval;

  final List<StreamSubscription<dynamic>> _subs = [];
  Timer? _ticker;

  Future<void> start() async {
    final socket = container.read(realtimeSocketProvider);
    await socket.connect();
    _subs.add(socket.rideOffer.listen(_onRideOffer));
    _subs.add(socket.rideOfferAccepted.listen(_onAccepted));
    _subs.add(socket.rideOfferRevoked.listen(_onRevoked));
    _subs.add(socket.rideOfferOutcome.listen(_onOutcome));
    _subs.add(socket.driverAssignment.listen(_onAssignment));
  }

  /// Last solo trip we routed to, so a snapshot on every reconnect does not
  /// re-navigate a driver who is already on it.
  String? _routedRideId;

  /// Set when an accept ack said `unavailable`: the server did not decide, so
  /// the next `driver:assignment` snapshot does (solo assigned → `/ride/:id`,
  /// none → home).
  bool _awaitingVerdict = false;

  void stop() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    _subs.clear();
    _cancelTicker();
  }

  OfferNotifier get _notifier => container.read(offerProvider.notifier);

  void _onRideOffer(Map<String, dynamic> payload) {
    final offer = SoloRideOffer.tryFromRideOfferJson(payload);
    if (offer == null) return; // shared offer — SharedRideController handles it
    _notifier.applyOffer(offer);
    _navigate('/offer/${offer.offerId}');
    _startTicker();
  }

  void _onAccepted(Map<String, dynamic> payload) {
    final offerId = payload['offerId'] as String?;
    final rideId = payload['rideId'] as String?;
    if (offerId == null || rideId == null) return;
    if (_notifier.applyAccepted(offerId: offerId, rideId: rideId)) {
      _cancelTicker();
      _routedRideId = rideId;
      _navigate('/ride/$rideId');
    }
  }

  void _onOutcome(Map<String, dynamic> payload) {
    final outcome = OfferOutcome.fromJson(payload);
    if (outcome == null || outcome.isShared) return;
    switch (outcome.kind) {
      case OfferOutcomeKind.assigned:
        final rideId = outcome.tripId;
        if (rideId != null) _onAccepted({'offerId': outcome.offerId, 'rideId': rideId});
        break;
      case OfferOutcomeKind.retry:
        _notifier.applyRetry(offerId: outcome.offerId);
        break;
      case OfferOutcomeKind.declined:
        break;
      case OfferOutcomeKind.unknown:
        // Undecided accept (`unavailable`): keep claiming and ask the server.
        final live = container.read(offerProvider);
        if (live.phase == OfferPhase.claiming && live.offer?.offerId == outcome.offerId) {
          _awaitingVerdict = true;
          container.read(realtimeSocketProvider).requestAssignmentSnapshot();
        }
        break;
      default:
        _onRevoked({'offerId': outcome.offerId, 'reason': outcome.reason ?? outcome.kind.name});
    }
  }

  void _onAssignment(Map<String, dynamic> payload) {
    final snapshot = DriverAssignmentSnapshot.fromJson(payload);
    final a = snapshot?.assignment;
    if (a == null) {
      _routedRideId = null;
      final live = container.read(offerProvider);
      if (_awaitingVerdict && live.phase == OfferPhase.claiming && live.offer != null) {
        // No committed assignment: the undecided accept did not win.
        _awaitingVerdict = false;
        _onRevoked({'offerId': live.offer!.offerId, 'reason': 'unavailable'});
      }
      return;
    }
    if (!a.isSolo) return;
    _awaitingVerdict = false;
    final current = container.read(offerProvider);
    if (current.offer != null && a.offerId == current.offer!.offerId) {
      _onAccepted({'offerId': a.offerId, 'rideId': a.tripId});
      return;
    }
    if (_routedRideId == a.tripId) return;
    _routedRideId = a.tripId;
    _navigate('/ride/${a.tripId}');
  }

  void _onRevoked(Map<String, dynamic> payload) {
    final offerId = payload['offerId'] as String?;
    if (offerId == null) return;
    final reason = payload['reason'] as String?;
    if (_notifier.applyRevoked(offerId: offerId, reason: reason)) {
      _cancelTicker();
      container.read(driverNoticeProvider.notifier).state = offerEndedNotice(reason);
      _navigate('/home');
    }
  }

  void _startTicker() {
    _cancelTicker();
    _ticker = Timer.periodic(tickInterval, (_) {
      _notifier.tick();
      if (container.read(offerProvider).phase == OfferPhase.expired) {
        _cancelTicker();
        container.read(driverNoticeProvider.notifier).state = offerEndedNotice('expired');
        _navigate('/home');
      }
    });
  }

  void _cancelTicker() {
    _ticker?.cancel();
    _ticker = null;
  }
}

final offerControllerProvider = Provider<OfferController>((ref) {
  throw UnimplementedError(
    'Provide a router when overriding offerControllerProvider.',
  );
});
