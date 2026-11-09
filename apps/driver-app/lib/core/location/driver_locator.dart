import 'package:geolocator/geolocator.dart';

/// Result of [DriverLocator.locate]: a fix, or a driver-readable reason why
/// there is none.
class LocateResult {
  const LocateResult.fix(Position this.position) : error = null;
  const LocateResult.error(String this.error) : position = null;

  final Position? position;
  final String? error;
}

/// Gets the driver's position for "go online", asking for the runtime location
/// permission first.
///
/// Before RCAB-E8.S14 the app never requested the permission and, when the
/// position call threw, went online at (0, 0) — off the coast of Africa, so
/// dispatch never found the driver. Now there is no fallback position: no
/// permission or no fix means the driver stays offline with a clear message.
class DriverLocator {
  DriverLocator({
    Future<bool> Function()? serviceEnabled,
    Future<LocationPermission> Function()? checkPermission,
    Future<LocationPermission> Function()? requestPermission,
    Future<Position> Function()? currentPosition,
    Future<Position?> Function()? lastKnownPosition,
  })  : _serviceEnabled = serviceEnabled ?? Geolocator.isLocationServiceEnabled,
        _checkPermission = checkPermission ?? Geolocator.checkPermission,
        _requestPermission = requestPermission ?? Geolocator.requestPermission,
        _currentPosition = currentPosition ??
            (() => Geolocator.getCurrentPosition(
                  desiredAccuracy: LocationAccuracy.high,
                  timeLimit: const Duration(seconds: 10),
                )),
        _lastKnownPosition = lastKnownPosition ?? Geolocator.getLastKnownPosition;

  final Future<bool> Function() _serviceEnabled;
  final Future<LocationPermission> Function() _checkPermission;
  final Future<LocationPermission> Function() _requestPermission;
  final Future<Position> Function() _currentPosition;
  final Future<Position?> Function() _lastKnownPosition;

  static const permissionMessage = 'Location permission is required to go online';
  static const serviceMessage = 'Turn on location services to go online';
  static const noFixMessage = 'Could not get your location. Try again.';

  Future<LocateResult> locate() async {
    if (!await _serviceEnabled()) return const LocateResult.error(serviceMessage);

    var permission = await _checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await _requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever ||
        permission == LocationPermission.unableToDetermine) {
      return const LocateResult.error(permissionMessage);
    }

    try {
      return LocateResult.fix(await _currentPosition());
    } catch (_) {
      try {
        final last = await _lastKnownPosition();
        if (last != null) return LocateResult.fix(last);
      } catch (_) {}
      return const LocateResult.error(noFixMessage);
    }
  }
}
