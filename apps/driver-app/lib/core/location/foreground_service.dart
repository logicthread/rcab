import 'dart:isolate';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import '../config/policy.dart';

// Allows test injection of a mock position getter. Null = no fix this tick.
typedef GetPositionFn = Future<Position?> Function();

/// One location fix for the background task, never unbounded: [current] gets
/// [timeout] (DriverPolicy.locationFixTimeoutMs), then [lastKnown] is used.
///
/// Before RCAB-E8.S14 the task awaited `getCurrentPosition` with no limit. In
/// the foreground-service engine that call can stay pending forever (seen on
/// the Android emulator after the first fix), so the driver sent one packet,
/// went silent, and the server swept them offline after drivers.staleAfterMs.
@visibleForTesting
Future<Position?> boundedFix({
  required Future<Position> Function() current,
  required Future<Position?> Function() lastKnown,
  Duration timeout = const Duration(milliseconds: DriverPolicy.locationFixTimeoutMs),
}) async {
  try {
    return await current().timeout(timeout);
  } catch (_) {
    try {
      return await lastKnown();
    } catch (_) {
      return null;
    }
  }
}

// Top-level entry point required by flutter_foreground_task (separate isolate).
@pragma('vm:entry-point')
void startForegroundTask() {
  FlutterForegroundTask.setTaskHandler(LocationTaskHandler());
}

/// Exposed for testing via @visibleForTesting. Production code uses the
/// top-level [startForegroundTask] callback which creates this class.
@visibleForTesting
class LocationTaskHandler extends TaskHandler {
  static const double minMeters = DriverPolicy.locationMinMoveMeters;

  /// Re-send an unchanged position after this long, so a parked driver keeps
  /// its server presence fresh (see [DriverPolicy.locationHeartbeatMs]).
  static const Duration heartbeat = Duration(milliseconds: DriverPolicy.locationHeartbeatMs);

  Position? lastEmitted;

  /// Task time of the last emit (the `timestamp` passed to [onRepeatEvent]).
  DateTime? lastEmittedAt;

  /// The service engine reads the platform LocationManager, not the fused
  /// provider: from this second Flutter engine the fused `getCurrentPosition`
  /// was observed never to resolve and its last-known fix never advanced
  /// while the device moved (RCAB-E8.S14, emulator API 29 with Play services).
  @visibleForTesting
  GetPositionFn getPosition = () => boundedFix(
        current: () => Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.medium,
          forceAndroidLocationManager: true,
        ),
        lastKnown: () => Geolocator.getLastKnownPosition(forceAndroidLocationManager: true),
      );

  @override
  void onStart(DateTime timestamp, SendPort? sendPort) {}

  @override
  Future<void> onRepeatEvent(DateTime timestamp, SendPort? sendPort) async {
    final Position pos;
    try {
      final fix = await getPosition();
      if (fix == null) return;
      pos = fix;
    } catch (_) {
      return;
    }

    final prev = lastEmitted;
    if (prev != null) {
      final dist = Geolocator.distanceBetween(
        prev.latitude, prev.longitude,
        pos.latitude, pos.longitude,
      );
      // Debounce jitter, but never go silent: the server sweeps a driver
      // offline after drivers.staleAfterMs without a location packet, so a
      // driver waiting at a stand used to be dropped after 60 s.
      final last = lastEmittedAt;
      final heartbeatDue = last != null && timestamp.difference(last) >= heartbeat;
      if (dist < minMeters && !heartbeatDue) return;
    }

    lastEmitted = pos;
    lastEmittedAt = timestamp;
    sendPort?.send({
      'lat': pos.latitude,
      'lng': pos.longitude,
      'heading': pos.heading,
      'speed': pos.speed,
    });
  }

  @override
  void onDestroy(DateTime timestamp, SendPort? sendPort) {
    lastEmitted = null;
    lastEmittedAt = null;
    // Best-effort: record kill time for the home-screen banner.
    // May not fire on hard OS kills; the app-resume health check is the primary path.
    FlutterForegroundTask.saveData(
      key: 'last_service_kill_at',
      value: DateTime.now().millisecondsSinceEpoch,
    );
  }
}

class ForegroundServiceManager {
  Future<void> startService() async {
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'rcab_online',
        channelName: 'rcab online status',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
      ),
      iosNotificationOptions: const IOSNotificationOptions(
        showNotification: false,
        playSound: false,
      ),
      foregroundTaskOptions: const ForegroundTaskOptions(
        interval: DriverPolicy.locationIntervalMs,
        autoRunOnBoot: true,
        allowWakeLock: true,
      ),
    );

    await FlutterForegroundTask.startService(
      notificationTitle: 'rcab',
      notificationText: 'You are online',
      callback: startForegroundTask,
    );
  }

  Future<void> stopService() async {
    await FlutterForegroundTask.stopService();
  }
}
