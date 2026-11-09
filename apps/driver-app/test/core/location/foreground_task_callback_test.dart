import 'dart:async';
import 'dart:isolate';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_app/core/config/policy.dart';
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
  // FlutterForegroundTask.saveData (called in onDestroy) uses SharedPreferences
  // which requires the Flutter binding and a mock platform.
  TestWidgetsFlutterBinding.ensureInitialized();
  SharedPreferences.setMockInitialValues({});

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

  // Regression (RCAB-E8.S14): a parked driver sent nothing after the first fix,
  // so the server's auto-offline sweep (drivers.staleAfterMs = 60 s) dropped them.
  group('LocationTaskHandler — stationary heartbeat', () {
    Future<List<Object?>> run(LocationTaskHandler h, DateTime at) async {
      final port = ReceivePort();
      final received = <Object?>[];
      final sub = port.listen(received.add);
      await h.onRepeatEvent(at, port.sendPort);
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();
      port.close();
      return received;
    }

    test('re-sends an unchanged position once the heartbeat is due', () async {
      final t0 = DateTime(2026, 11, 9, 12);
      final handler = LocationTaskHandler()..getPosition = () async => _pos(26.19, 91.82);

      expect(await run(handler, t0), hasLength(1));
      expect(await run(handler, t0.add(const Duration(seconds: 5))), isEmpty);
      expect(
        await run(handler, t0.add(LocationTaskHandler.heartbeat)),
        hasLength(1),
      );
    });

    test('heartbeat stays well inside the server stale window (60 s)', () {
      expect(LocationTaskHandler.heartbeat.inSeconds, lessThanOrEqualTo(30));
    });
  });

  // Regression (RCAB-E8.S14): the task awaited getCurrentPosition with no
  // limit; in the service engine it could stay pending forever after the first
  // fix, so nothing more was streamed and the driver was swept offline.
  group('boundedFix', () {
    const short = Duration(milliseconds: 20);

    test('returns the current fix when it resolves in time', () async {
      final p = await boundedFix(
        current: () async => _pos(26.19, 91.82),
        lastKnown: () async => _pos(0, 0),
        timeout: short,
      );
      expect(p!.latitude, closeTo(26.19, 1e-9));
    });

    test('falls back to the last known position when the fix never resolves', () async {
      final never = Completer<Position>();
      final p = await boundedFix(
        current: () => never.future,
        lastKnown: () async => _pos(26.18, 91.81),
        timeout: short,
      );
      expect(p!.latitude, closeTo(26.18, 1e-9));
    });

    test('falls back when the fix throws, and yields null when nothing is known', () async {
      final p = await boundedFix(
        current: () async => throw StateError('no provider'),
        lastKnown: () async => null,
        timeout: short,
      );
      expect(p, isNull);
    });

    test('a null fix emits nothing and keeps the handler alive', () async {
      final handler = LocationTaskHandler()..getPosition = () async => null;
      final port = ReceivePort();
      final received = <Object?>[];
      final sub = port.listen(received.add);
      await handler.onRepeatEvent(DateTime(2026), port.sendPort);
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();
      port.close();
      expect(received, isEmpty);
      expect(handler.lastEmitted, isNull);
    });

    test('the bound fits inside one task interval', () {
      expect(DriverPolicy.locationFixTimeoutMs, lessThan(DriverPolicy.locationIntervalMs));
    });
  });
}
