import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../di/providers.dart';
import 'offer_models.dart';

/// Holds the state of the at-most-one in-flight solo offer. The socket→state
/// glue and navigation live in `OfferController`; this notifier is pure state
/// so its logic (countdown, accept/decline, win/lose matching) is unit-testable
/// without timers or a real socket.
class OfferNotifier extends StateNotifier<OfferState> {
  OfferNotifier(this._sender) : super(OfferState.empty);

  final OfferResponseSender _sender;

  /// Apply an incoming solo `ride_offer`: start ringing with the countdown
  /// seeded from the payload's `ttlMs`.
  void applyOffer(SoloRideOffer offer) {
    state = OfferState(
      phase: OfferPhase.ringing,
      offer: offer,
      secondsLeft: (offer.ttlMs / 1000).ceil(),
    );
  }

  /// One countdown step. Only ticks while ringing; flips to `expired` at zero.
  void tick() {
    if (state.phase != OfferPhase.ringing) return;
    final next = state.secondsLeft - 1;
    state = next <= 0
        ? state.copyWith(phase: OfferPhase.expired, secondsLeft: 0)
        : state.copyWith(secondsLeft: next);
  }

  /// Driver tapped Accept: emit the response and await the server verdict.
  void accept() {
    final offer = state.offer;
    if (offer == null || state.phase != OfferPhase.ringing) return;
    _sender.sendOfferResponse(offerId: offer.offerId, accept: true);
    state = state.copyWith(phase: OfferPhase.claiming);
  }

  /// Driver tapped Decline: release the offer server-side and dismiss.
  void decline() {
    final offer = state.offer;
    if (offer == null) return;
    if (state.phase == OfferPhase.ringing || state.phase == OfferPhase.claiming) {
      _sender.sendOfferResponse(offerId: offer.offerId, accept: false);
    }
    state = OfferState.empty;
  }

  /// `ride_offer_accepted` — we won. Ignored unless it matches the live offer
  /// (a late echo for a previous offer must not hijack the current one).
  bool applyAccepted({required String offerId, required String rideId}) {
    final offer = state.offer;
    if (offer == null || offer.offerId != offerId) return false;
    if (state.phase == OfferPhase.accepted) return false;
    state = state.copyWith(phase: OfferPhase.accepted, rideId: rideId);
    return true;
  }

  /// `ride_offer_revoked` — someone else won / the client cancelled. Matched by
  /// `offerId` like [applyAccepted].
  bool applyRevoked({required String offerId, String? reason}) {
    final offer = state.offer;
    if (offer == null || offer.offerId != offerId) return false;
    if (state.phase == OfferPhase.revoked) return false;
    state = state.copyWith(phase: OfferPhase.revoked, revokeReason: reason);
    return true;
  }

  void reset() => state = OfferState.empty;
}

/// Sender for `ride_offer_response`. Defaults to the realtime socket so
/// `OfferScreen` builds without an explicit override (the router smoke test
/// pumps it with no offer wiring); offer-flow tests override
/// `realtimeSocketProvider` with a fake to capture the emit.
final offerResponseSenderProvider = Provider<OfferResponseSender>(
  (ref) => ref.watch(realtimeSocketProvider),
);

final offerProvider = StateNotifierProvider<OfferNotifier, OfferState>(
  (ref) => OfferNotifier(ref.watch(offerResponseSenderProvider)),
);
