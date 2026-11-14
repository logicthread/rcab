sealed class DriverState {
  const DriverState();
}

final class DriverOffline extends DriverState {
  const DriverOffline();
}

final class DriverOnline extends DriverState {
  const DriverOnline({required this.vehicleId, required this.sessionId});

  /// The vehicle picked in this app session, if any (the server holds the
  /// authoritative current vehicle).
  final String? vehicleId;
  final String sessionId;
}

final class DriverOnRide extends DriverState {
  const DriverOnRide({required this.vehicleId, required this.rideId});
  final String vehicleId;
  final String rideId;
}
