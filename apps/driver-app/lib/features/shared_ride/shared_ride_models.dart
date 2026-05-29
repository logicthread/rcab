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
  });

  final String sharedRideId;
  final List<SharedRideStop> stops;
  final int passengerCount;
  final String? offerId;

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

class SharedRideState {
  const SharedRideState({
    this.sharedRideId,
    this.stops = const <StopState>[],
    this.currentStopIndex = 0,
    this.completed = false,
  });

  final String? sharedRideId;
  final List<StopState> stops;
  final int currentStopIndex;
  final bool completed;

  bool get isEmpty => sharedRideId == null;

  StopState? get currentStop {
    if (currentStopIndex < 0 || currentStopIndex >= stops.length) return null;
    return stops[currentStopIndex];
  }

  SharedRideState copyWith({
    String? sharedRideId,
    List<StopState>? stops,
    int? currentStopIndex,
    bool? completed,
  }) {
    return SharedRideState(
      sharedRideId: sharedRideId ?? this.sharedRideId,
      stops: stops ?? this.stops,
      currentStopIndex: currentStopIndex ?? this.currentStopIndex,
      completed: completed ?? this.completed,
    );
  }

  static const empty = SharedRideState();
}
