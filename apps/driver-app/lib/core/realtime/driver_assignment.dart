/// The driver's committed assignment as sent by the server on every socket
/// (re)connect (`driver:assignment`) and on request (`driver:sync`). Built
/// from Postgres `driver_active_assignment`, it is the authority for restoring
/// the active trip after a cold start, a reconnect or a lost accept ack.
class DriverAssignment {
  const DriverAssignment({
    required this.tripKind,
    required this.tripId,
    required this.generation,
    required this.version,
    this.offerId,
    this.status,
    this.poolStatus,
    this.stops = const <Map<String, dynamic>>[],
  });

  /// `solo` | `shared`.
  final String tripKind;
  final String tripId;
  final String? offerId;
  final int generation;
  final int version;

  /// Solo ride status.
  final String? status;

  /// Shared pool state.
  final String? poolStatus;

  /// Shared itinerary (`sequenceIndex`, `type`, `passengerId`, `lat`, `lng`,
  /// `confirmed`, `confirmedAt`), already ordered by the server.
  final List<Map<String, dynamic>> stops;

  bool get isShared => tripKind == 'shared';
  bool get isSolo => tripKind == 'solo';

  /// Parse a single assignment view, or null when absent / malformed.
  static DriverAssignment? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final kind = raw['tripKind'];
    final tripId = raw['tripId'];
    if ((kind != 'solo' && kind != 'shared') || tripId is! String) return null;
    final stopsRaw = raw['stops'];
    return DriverAssignment(
      tripKind: kind as String,
      tripId: tripId,
      offerId: raw['offerId'] as String?,
      generation: (raw['generation'] as num?)?.toInt() ?? 0,
      version: (raw['version'] as num?)?.toInt() ?? 0,
      status: raw['status'] as String?,
      poolStatus: raw['poolStatus'] as String?,
      stops: stopsRaw is List
          ? stopsRaw
              .whereType<Map>()
              .map((m) => m.map((k, v) => MapEntry(k.toString(), v)))
              .toList()
          : const <Map<String, dynamic>>[],
    );
  }
}

/// A `driver:assignment` snapshot: [assignment] null ⇒ the driver holds no
/// active trip (anything the app still shows as active was released).
class DriverAssignmentSnapshot {
  const DriverAssignmentSnapshot(this.assignment);

  final DriverAssignment? assignment;

  /// Null when the payload is not a snapshot at all (e.g. an error ack).
  static DriverAssignmentSnapshot? fromJson(Map<String, dynamic> json) {
    if (!json.containsKey('assignment')) return null;
    return DriverAssignmentSnapshot(DriverAssignment.fromJson(json['assignment']));
  }
}
