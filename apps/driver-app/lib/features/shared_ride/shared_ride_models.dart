import '../../core/config/policy.dart';

enum StopType { pickup, dropoff }

enum StopStatus { pending, confirmed }

class SharedRideStop {
  const SharedRideStop({
    required this.sequenceIndex,
    required this.passengerId,
    required this.type,
    required this.lat,
    required this.lng,
  });

  final int sequenceIndex;
  final String passengerId;
  final StopType type;
  final double lat;
  final double lng;

  String get typeLabel => type == StopType.pickup ? 'PICKUP' : 'DROP';

  static StopType parseType(Object? raw) {
    if (raw is String) {
      if (raw == 'pickup') return StopType.pickup;
      if (raw == 'dropoff' || raw == 'drop') return StopType.dropoff;
    }
    throw ArgumentError('Unknown stop type: $raw');
  }

  static SharedRideStop fromOfferJson(Map<String, dynamic> json) {
    return SharedRideStop(
      sequenceIndex: json['sequenceIndex'] as int,
      passengerId: json['passengerId'] as String,
      type: parseType(json['type']),
      lat: (json['lat'] as num).toDouble(),
      lng: (json['lng'] as num).toDouble(),
    );
  }
}

class StopState {
  const StopState({required this.stop, required this.status, this.confirmedAt});

  final SharedRideStop stop;
  final StopStatus status;
  final DateTime? confirmedAt;

  StopState copyWith({StopStatus? status, DateTime? confirmedAt}) {
    return StopState(
      stop: stop,
      status: status ?? this.status,
      confirmedAt: confirmedAt ?? this.confirmedAt,
    );
  }
}

class SharedRideOffer {
  const SharedRideOffer({
    required this.sharedRideId,
    required this.stops,
    required this.passengerCount,
    this.offerId,
    this.ttlMs = DriverPolicy.offerTtlFallbackMs,
  });

  final String sharedRideId;
  final List<SharedRideStop> stops;
  final int passengerCount;
  final String? offerId;

  /// Offer lifetime; the server's `expiresAt` (DB clock) is authoritative,
  /// the local countdown is advisory.
  final int ttlMs;

  /// Parse a `ride_offer` WS event into a [SharedRideOffer], or return null
  /// when the payload represents a solo ride (no `stops` array).
  static SharedRideOffer? tryFromRideOfferJson(Map<String, dynamic> json) {
    final stopsRaw = json['stops'];
    if (stopsRaw is! List) return null;
    if (stopsRaw.isEmpty) return null;
    final stops = stopsRaw
        .whereType<Map<String, dynamic>>()
        .map(SharedRideStop.fromOfferJson)
        .toList();
    if (stops.isEmpty) return null;
    return SharedRideOffer(
      sharedRideId: json['sharedRideId'] as String,
      stops: stops,
      passengerCount:
          (json['passengerCount'] as int?) ?? _distinctPassengers(stops),
      offerId: json['offerId'] as String?,
      ttlMs: (json['ttlMs'] as num?)?.toInt() ?? DriverPolicy.offerTtlFallbackMs,
    );
  }

  static int _distinctPassengers(List<SharedRideStop> stops) {
    final ids = <String>{};
    for (final s in stops) {
      ids.add(s.passengerId);
    }
    return ids.length;
  }
}

/// Where the driver stands with a shared trip (R09). An incoming offer is NOT
/// an assignment: stop commands are enabled only in [assigned], which is
/// entered solely on a committed server outcome (ack / `ride_offer_outcome`)
/// or an authoritative `driver:assignment` snapshot.
enum SharedRidePhase {
  none,

  /// Ringing: proposed itinerary shown, Accept / Decline enabled.
  offered,

  /// Accept sent; waiting for the server's verdict.
  accepting,

  /// Committed assignment: the stop screen is live.
  assigned,

  /// Terminal offer outcomes — the controller returns the driver home.
  lost,
  expired,
  revoked,
  rejected,
}

class SharedRideState {
  const SharedRideState({
    this.sharedRideId,
    this.stops = const <StopState>[],
    this.currentStopIndex = 0,
    this.completed = false,
    this.phase = SharedRidePhase.none,
    this.offerId,
    this.passengerCount = 0,
    this.secondsLeft = 0,
    this.generation,
    this.outcomeReason,
  });

  final String? sharedRideId;
  final List<StopState> stops;
  final int currentStopIndex;
  final bool completed;
  final SharedRidePhase phase;
  final String? offerId;
  final int passengerCount;
  final int secondsLeft;

  /// Dispatch generation of the committed assignment.
  final int? generation;

  /// Server reason for a terminal outcome (`trip_taken`, `driver_busy`, …).
  final String? outcomeReason;

  bool get isEmpty => sharedRideId == null;
  bool get isOffer =>
      phase == SharedRidePhase.offered || phase == SharedRidePhase.accepting;
  bool get isAssigned => phase == SharedRidePhase.assigned;
  bool get isTerminalOutcome =>
      phase == SharedRidePhase.lost ||
      phase == SharedRidePhase.expired ||
      phase == SharedRidePhase.revoked ||
      phase == SharedRidePhase.rejected;

  StopState? get currentStop {
    if (currentStopIndex < 0 || currentStopIndex >= stops.length) return null;
    return stops[currentStopIndex];
  }

  SharedRideState copyWith({
    String? sharedRideId,
    List<StopState>? stops,
    int? currentStopIndex,
    bool? completed,
    SharedRidePhase? phase,
    String? offerId,
    int? passengerCount,
    int? secondsLeft,
    int? generation,
    String? outcomeReason,
  }) {
    return SharedRideState(
      sharedRideId: sharedRideId ?? this.sharedRideId,
      stops: stops ?? this.stops,
      currentStopIndex: currentStopIndex ?? this.currentStopIndex,
      completed: completed ?? this.completed,
      phase: phase ?? this.phase,
      offerId: offerId ?? this.offerId,
      passengerCount: passengerCount ?? this.passengerCount,
      secondsLeft: secondsLeft ?? this.secondsLeft,
      generation: generation ?? this.generation,
      outcomeReason: outcomeReason ?? this.outcomeReason,
    );
  }

  static const empty = SharedRideState();
}
