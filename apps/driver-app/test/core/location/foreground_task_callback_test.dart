import 'dart:isolate';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

import 'package:driver_app/core/location/foreground_service.dart';

Position _pos(double lat, double lng) => Position.fromMap({
      'latitude': lat,
      'longitude': lng,
      'timestamp': DateTime.now().millisecondsSinceEpoch,
      'accuracy': 0.0,
      'altitude': 0.0,
      'heading': 0.0,
      'speed': 0.0,
      'speedAccuracy': 0.0,
      'altitudeAccuracy': 0.0,
      'headingAccuracy': 0.0,
    });

void main() {
  final now = DateTime.now();

  group('LocationTaskHandler — 10 m debounce', () {
    test('emits via sendPort when first position received (no previous)', () async {
      final port = ReceivePort();
      addTearDown(port.close);

      final handler = LocationTaskHandler();
      handler.getPosition = () async => _pos(1.30, 103.80);

      // Start listening before the async call
      final received = <Object?>[];
      final sub = port.listen(received.add);
      addTearDown(sub.cancel);

      await handler.onRepeatEvent(now, port.sendPort);
      // Give the isolate message pump a turn
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
      final data = received.first as Map<String, dynamic>;
      expect(data['lat'], closeTo(1.30, 0.0001));
      expect(data['lng'], closeTo(103.80, 0.0001));
    });

    test('emits when moved more than 10 m', () async {
      final port = ReceivePort();
      addTearDown(port.close);

      final handler = LocationTaskHandler();
      handler.lastEmitted = _pos(1.3000, 103.8000);
      // ~111 m north (0.001 deg latitude ≈ 111 m)
      handler.getPosition = () async => _pos(1.3010, 103.8000);

      final received = <Object?>[];
      final sub = port.listen(received.add);
      addTearDown(sub.cancel);

      await handler.onRepeatEvent(now, port.sendPort);
      await Future<void>.delayed(Duration.zero);

      expect(received, hasLength(1));
    });

    test('skips emit when moved less than 10 m', () async {
      final port = ReceivePort();
      addTearDown(port.close);

      final handler = LocationTaskHandler();
      handler.lastEmitted = _pos(1.3000, 103.8000);
      // ~1 m displacement — below the 10 m threshold
      handler.getPosition = () async => _pos(1.30001, 103.80000);

      final received = <Object?>[];
      final sub = port.listen(received.add);
      addTearDown(sub.cancel);

      await handler.onRepeatEvent(now, port.sendPort);
      await Future<void>.delayed(Duration.zero);

      expect(received, isEmpty);
    });

    test('onDestroy resets lastEmitted', () {
      final port = ReceivePort();
      addTearDown(port.close);

      final handler = LocationTaskHandler();
      handler.lastEmitted = _pos(1.3, 103.8);
      handler.onDestroy(now, port.sendPort);

      expect(handler.lastEmitted, isNull);
    });
  });
}
