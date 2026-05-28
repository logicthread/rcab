import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';

import 'package:driver_app/di/providers.dart';

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
  group('locationStreamProvider', () {
    test('emits positions piped from the underlying position stream', () async {
      final controller = StreamController<Position>();

      final container = ProviderContainer(
        overrides: [
          locationStreamProvider.overrideWith(
            (ref) => controller.stream,
          ),
        ],
      );
      addTearDown(container.dispose);
      addTearDown(controller.close);

      final emitted = <Position>[];
      final sub = container.listen<AsyncValue<Position>>(
        locationStreamProvider,
        (_, next) {
          if (next case AsyncData(:final value)) emitted.add(value);
        },
        fireImmediately: false,
      );
      addTearDown(sub.close);

      final p1 = _pos(1.30, 103.80);
      final p2 = _pos(1.31, 103.81);
      controller.add(p1);
      controller.add(p2);

      await Future<void>.delayed(Duration.zero);

      expect(emitted, hasLength(2));
      expect(emitted[0].latitude, closeTo(1.30, 0.0001));
      expect(emitted[1].latitude, closeTo(1.31, 0.0001));
    });

    test('transitions to AsyncError when stream emits an error', () async {
      final controller = StreamController<Position>();

      final container = ProviderContainer(
        overrides: [
          locationStreamProvider.overrideWith((ref) => controller.stream),
        ],
      );
      addTearDown(container.dispose);
      addTearDown(controller.close);

      AsyncValue<Position>? lastValue;
      final sub = container.listen<AsyncValue<Position>>(
        locationStreamProvider,
        (_, next) => lastValue = next,
        fireImmediately: false,
      );
      addTearDown(sub.close);

      controller.addError(Exception('location permission denied'));
      await Future<void>.delayed(Duration.zero);

      expect(lastValue, isA<AsyncError<Position>>());
    });
  });
}
