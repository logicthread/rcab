import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

import 'package:driver_app/core/location/driver_locator.dart';

Position _pos(double lat, double lng) => Position(
      latitude: lat,
      longitude: lng,
      timestamp: DateTime(2026, 11, 9),
      accuracy: 5,
      altitude: 0,
      altitudeAccuracy: 0,
      heading: 0,
      headingAccuracy: 0,
      speed: 0,
      speedAccuracy: 0,
    );

// Regression (RCAB-E8.S14): "go online" never asked for the location
// permission and fell back to (0, 0) when the position call threw.
void main() {
  test('asks for the permission when it is not granted yet', () async {
    var asked = 0;
    final r = await DriverLocator(
      serviceEnabled: () async => true,
      checkPermission: () async => LocationPermission.denied,
      requestPermission: () async {
        asked++;
        return LocationPermission.whileInUse;
      },
      currentPosition: () async => _pos(26.19, 91.82),
    ).locate();
    expect(asked, 1);
    expect(r.position!.latitude, 26.19);
  });

  test('denied permission → error, never a (0, 0) position', () async {
    final r = await DriverLocator(
      serviceEnabled: () async => true,
      checkPermission: () async => LocationPermission.denied,
      requestPermission: () async => LocationPermission.deniedForever,
      currentPosition: () async => fail('must not read the position'),
    ).locate();
    expect(r.position, isNull);
    expect(r.error, DriverLocator.permissionMessage);
  });

  test('location services off → error', () async {
    final r = await DriverLocator(serviceEnabled: () async => false).locate();
    expect(r.error, DriverLocator.serviceMessage);
  });

  test('no current fix falls back to the last known one, else errors', () async {
    final withLast = await DriverLocator(
      serviceEnabled: () async => true,
      checkPermission: () async => LocationPermission.always,
      currentPosition: () async => throw TimeoutException('gps'),
      lastKnownPosition: () async => _pos(26.18, 91.81),
    ).locate();
    expect(withLast.position!.longitude, 91.81);

    final none = await DriverLocator(
      serviceEnabled: () async => true,
      checkPermission: () async => LocationPermission.always,
      currentPosition: () async => throw TimeoutException('gps'),
      lastKnownPosition: () async => null,
    ).locate();
    expect(none.position, isNull);
    expect(none.error, DriverLocator.noFixMessage);
  });
}

class TimeoutException implements Exception {
  TimeoutException(this.message);
  final String message;
}
