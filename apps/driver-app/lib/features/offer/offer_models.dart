/// Transport seam: lets [OfferNotifier] emit a `ride_offer_response` without a
/// real `socket_io_client` in tests. Implemented by `RealtimeSocket`. Lives in
/// this import-free file so the realtime layer and the provider layer can both
/// depend on it without an import cycle.
abstract class OfferResponseSender {
  void sendOfferResponse({required String offerId, required bool accept});
}

/// Lifecycle of a single solo ride offer on the driver app.
///
/// `ringing` → driver is being asked; `claiming` → driver tapped Accept and we
/// are awaiting the server verdict; then exactly one terminal phase:
/// `accepted` (we won — route to the ride), `revoked` (someone else won / the
/// client cancelled), or `expired` (the 12 s TTL lapsed with no decision).
enum OfferPhase { idle, ringing, claiming, accepted, revoked, expired }

/// A solo `ride_offer` as fanned out by `DispatchService.runSoloWave`
/// (RCAB-E4.S3). The shared-ride variant is [SharedRideOffer]; the two are
/// distinguished by the presence of a `stops` array.
class SoloRideOffer {
  const SoloRideOffer({
    required this.offerId,
    required this.rideId,
    required this.ttlMs,
    required this.pickupLat,
    required this.pickupLng,
    required this.dropoffLat,
    required this.dropoffLng,
    required this.fareCents,
    required this.waveNumber,
  });

  final String offerId;
  final String rideId;
  final int ttlMs;
  final double pickupLat;
  final double pickupLng;
  final double dropoffLat;
  final double dropoffLng;
  final int fareCents;
  final int waveNumber;

  /// Fare in major currency units (₹). The server quotes in integer cents.
  String get fareDisplay => '₹${(fareCents / 100).toStringAsFixed(2)}';

  /// Parse a `ride_offer` WS event into a [SoloRideOffer], or return null when
  /// the payload is a shared ride (carries a `stops` array — that belongs to
  /// [SharedRideOffer]) or is missing the solo fields. Mirrors the solo/shared
  /// split used by `SharedRideOffer.tryFromRideOfferJson`.
  static SoloRideOffer? tryFromRideOfferJson(Map<String, dynamic> json) {
    if (json['stops'] is List) return null; // shared offer — not ours
    final offerId = json['offerId'];
    final rideId = json['rideId'];
    final pickup = json['pickup'];
    final dropoff = json['dropoff'];
    if (offerId is! String || rideId is! String) return null;
    if (pickup is! Map || dropoff is! Map) return null;
    final pLat = pickup['lat'], pLng = pickup['lng'];
    final dLat = dropoff['lat'], dLng = dropoff['lng'];
    if (pLat is! num || pLng is! num || dLat is! num || dLng is! num) {
      return null;
    }
    return SoloRideOffer(
      offerId: offerId,
      rideId: rideId,
      ttlMs: (json['ttlMs'] as num?)?.toInt() ?? 12000,
      pickupLat: pLat.toDouble(),
      pickupLng: pLng.toDouble(),
      dropoffLat: dLat.toDouble(),
      dropoffLng: dLng.toDouble(),
      fareCents: (json['fareCents'] as num?)?.toInt() ?? 0,
      waveNumber: (json['waveNumber'] as num?)?.toInt() ?? 1,
    );
  }
}

/// Immutable UI state for the offer screen, driven by [OfferNotifier].
class OfferState {
  const OfferState({
    this.phase = OfferPhase.idle,
    this.offer,
    this.secondsLeft = 0,
    this.rideId,
    this.revokeReason,
  });

  final OfferPhase phase;
  final SoloRideOffer? offer;
  final int secondsLeft;

  /// Set once the offer is won; the target of the post-accept navigation.
  final String? rideId;

  /// `taken` / `unavailable` — populated on [OfferPhase.revoked].
  final String? revokeReason;

  bool get isRinging => phase == OfferPhase.ringing;
  bool get isClaiming => phase == OfferPhase.claiming;

  OfferState copyWith({
    OfferPhase? phase,
    SoloRideOffer? offer,
    int? secondsLeft,
    String? rideId,
    String? revokeReason,
  }) {
    return OfferState(
      phase: phase ?? this.phase,
      offer: offer ?? this.offer,
      secondsLeft: secondsLeft ?? this.secondsLeft,
      rideId: rideId ?? this.rideId,
      revokeReason: revokeReason ?? this.revokeReason,
    );
  }

  static const empty = OfferState();
}
