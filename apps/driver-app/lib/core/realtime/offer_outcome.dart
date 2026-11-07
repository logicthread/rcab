/// Explicit offer outcome protocol (R09 / F10). Import-free so both the
/// realtime layer and the offer / shared-ride features can depend on it.
///
/// The server answers every offer the driver acted on with exactly one
/// outcome, delivered twice for robustness: as the Socket.IO ack of
/// `ride_offer_response` and as a `ride_offer_outcome` event. Both are
/// normalised to the same JSON shape, so controllers have one code path, and
/// applying the same outcome twice is a no-op.
enum OfferOutcomeKind {
  /// The accept committed: the driver now holds the trip.
  assigned,

  /// Another driver won the trip.
  lost,

  /// The offer lapsed (DB clock) or belonged to an old dispatch generation.
  expired,

  /// The trip went away (cancelled, hard-fail, aborted pool).
  revoked,

  /// The accept was refused for a driver-side reason (busy, ineligible, …).
  rejected,

  /// The server could not decide (bounded lock retry exhausted); the offer is
  /// still live, so the driver may accept again.
  retry,

  /// Our own decline was recorded.
  declined,

  /// The server could not answer (`unavailable`: Redis / DB hiccup). The
  /// accept may or may not have committed, so this is NOT a loss: keep
  /// waiting and let a `driver:assignment` snapshot decide.
  unknown;

  static OfferOutcomeKind? parse(Object? raw) {
    if (raw is! String) return null;
    for (final k in OfferOutcomeKind.values) {
      if (k.name == raw) return k;
    }
    return null;
  }

  bool get isTerminalLoss =>
      this == lost || this == expired || this == revoked || this == rejected;
}

/// Map an accept refusal reason (the server's `AcceptOfferResult.reason`) to
/// the outcome the UI shows. Mirrors `outcomeForAcceptFailure` on the api.
OfferOutcomeKind outcomeForAcceptFailure(String? reason) {
  switch (reason) {
    case 'trip_taken':
      return OfferOutcomeKind.lost;
    case 'offer_expired':
    case 'offer_stale':
      return OfferOutcomeKind.expired;
    case 'offer_revoked':
    case 'trip_not_claimable':
      return OfferOutcomeKind.revoked;
    case 'conflict':
      return OfferOutcomeKind.retry;
    case 'unavailable':
      return OfferOutcomeKind.unknown;
    default:
      return OfferOutcomeKind.rejected;
  }
}

class OfferOutcome {
  const OfferOutcome({
    required this.offerId,
    required this.kind,
    this.tripKind,
    this.tripId,
    this.generation,
    this.reason,
    this.assignment,
  });

  final String offerId;
  final OfferOutcomeKind kind;

  /// `solo` | `shared` — present on `assigned` and on outcomes for own offers.
  final String? tripKind;
  final String? tripId;
  final int? generation;
  final String? reason;

  /// The committed assignment (server `DriverAssignmentView`) when known.
  final Map<String, dynamic>? assignment;

  bool get isShared => tripKind == 'shared';

  static OfferOutcome? fromJson(Map<String, dynamic> json) {
    final offerId = json['offerId'];
    final kind = OfferOutcomeKind.parse(json['outcome']);
    if (offerId is! String || kind == null) return null;
    final assignment = json['assignment'];
    return OfferOutcome(
      offerId: offerId,
      kind: kind,
      tripKind: json['tripKind'] as String?,
      tripId: json['tripId'] as String?,
      generation: (json['generation'] as num?)?.toInt(),
      reason: json['reason'] as String?,
      assignment: assignment is Map
          ? assignment.map((k, v) => MapEntry(k.toString(), v))
          : null,
    );
  }

  /// Normalise a `ride_offer_response` ack to the `ride_offer_outcome` JSON
  /// shape. Returns null for an ack that carries nothing usable.
  static Map<String, dynamic>? jsonFromAck({
    required String offerId,
    required bool accept,
    required Object? ack,
  }) {
    if (!accept) {
      return {'offerId': offerId, 'outcome': OfferOutcomeKind.declined.name, 'source': 'ack'};
    }
    if (ack is! Map) return null;
    if (ack['ok'] == true) {
      final trip = ack['trip'];
      if (trip is! Map) return null;
      final kind = trip['kind'];
      final tripId = kind == 'solo' ? trip['rideId'] : trip['sharedRideId'];
      return {
        'offerId': offerId,
        'outcome': OfferOutcomeKind.assigned.name,
        'tripKind': kind,
        'tripId': tripId,
        'generation': ack['generation'],
        'source': 'ack',
      };
    }
    final reason = ack['reason'] as String?;
    return {
      'offerId': offerId,
      'outcome': outcomeForAcceptFailure(reason).name,
      'reason': reason,
      'source': 'ack',
    };
  }
}
