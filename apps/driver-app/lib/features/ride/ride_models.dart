/// Solo ride lifecycle as seen by the driver app. The wire values match the
/// `rides.status` column (RCAB-E4.S6); `en_route` / `arrived` carry no
/// `_pickup` suffix for solo rides.
enum RideStatus {
  requested,
  dispatching,
  accepted,
  enRoute,
  arrived,
  inProgress,
  completed,
  cancelled,
  noDriver,
  unknown;

  static RideStatus parse(String? s) => switch (s) {
        'requested' => RideStatus.requested,
        'dispatching' => RideStatus.dispatching,
        'accepted' => RideStatus.accepted,
        'en_route' => RideStatus.enRoute,
        'arrived' => RideStatus.arrived,
        'in_progress' => RideStatus.inProgress,
        'completed' => RideStatus.completed,
        'cancelled' => RideStatus.cancelled,
        'no_driver' => RideStatus.noDriver,
        _ => RideStatus.unknown,
      };

  /// The forward lifecycle event the driver can fire from this status, or null
  /// when there is no forward action (pre-accept or terminal).
  String? get nextEvent => switch (this) {
        RideStatus.accepted => 'start_en_route',
        RideStatus.enRoute => 'mark_arrived',
        RideStatus.arrived => 'start_ride',
        RideStatus.inProgress => 'end_ride',
        _ => null,
      };

  /// Label for the single primary action button.
  String? get actionLabel => switch (this) {
        RideStatus.accepted => 'Start trip',
        RideStatus.enRoute => "I've arrived",
        RideStatus.arrived => 'Start ride',
        RideStatus.inProgress => 'End ride',
        _ => null,
      };

  /// Once the passenger is aboard, the driver navigates to the dropoff; until
  /// then, to the pickup.
  bool get isHeadingToDropoff => this == RideStatus.inProgress || this == RideStatus.completed;

  bool get isTerminal => this == RideStatus.completed || this == RideStatus.cancelled;
}

/// Parsed `GET /v1/rides/:id` payload (the fields the driver screen needs).
class RideDetail {
  const RideDetail({
    required this.rideId,
    required this.status,
    required this.originLat,
    required this.originLng,
    required this.destLat,
    required this.destLng,
  });

  final String rideId;
  final String status;
  final double originLat;
  final double originLng;
  final double destLat;
  final double destLng;

  static RideDetail fromJson(Map<String, dynamic> json) {
    final origin = (json['origin'] as Map?)?.cast<String, dynamic>() ?? const {};
    final dropoff = (json['dropoff'] as Map?)?.cast<String, dynamic>() ?? const {};
    return RideDetail(
      rideId: json['rideId'] as String,
      status: json['status'] as String,
      originLat: (origin['lat'] as num).toDouble(),
      originLng: (origin['lng'] as num).toDouble(),
      destLat: (dropoff['lat'] as num).toDouble(),
      destLng: (dropoff['lng'] as num).toDouble(),
    );
  }
}

/// UI state for `/ride/:id`.
class RideState {
  const RideState({
    required this.rideId,
    required this.status,
    this.originLat,
    this.originLng,
    this.destLat,
    this.destLng,
    this.loaded = false,
    this.busy = false,
  });

  final String rideId;
  final RideStatus status;
  final double? originLat;
  final double? originLng;
  final double? destLat;
  final double? destLng;

  /// True once the initial `GET /v1/rides/:id` has resolved (success or not).
  final bool loaded;

  /// True while a transition POST is in flight (button shows progress).
  final bool busy;

  static RideState initial(String rideId) =>
      RideState(rideId: rideId, status: RideStatus.unknown);

  bool get hasCoords =>
      originLat != null && originLng != null && destLat != null && destLng != null;

  /// Current navigation target — dropoff once aboard, pickup before.
  double? get navLat => status.isHeadingToDropoff ? destLat : originLat;
  double? get navLng => status.isHeadingToDropoff ? destLng : originLng;

  RideState copyWith({
    RideStatus? status,
    double? originLat,
    double? originLng,
    double? destLat,
    double? destLng,
    bool? loaded,
    bool? busy,
  }) {
    return RideState(
      rideId: rideId,
      status: status ?? this.status,
      originLat: originLat ?? this.originLat,
      originLng: originLng ?? this.originLng,
      destLat: destLat ?? this.destLat,
      destLng: destLng ?? this.destLng,
      loaded: loaded ?? this.loaded,
      busy: busy ?? this.busy,
    );
  }
}
