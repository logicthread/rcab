import 'dart:isolate';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';

// Allows test injection of a mock position getter.
typedef GetPositionFn = Future<Position> Function();

// Top-level entry point required by flutter_foreground_task (separate isolate).
@pragma('vm:entry-point')
void startForegroundTask() {
  FlutterForegroundTask.setTaskHandler(LocationTaskHandler());
}

/// Exposed for testing via @visibleForTesting. Production code uses the
/// top-level [startForegroundTask] callback which creates this class.
@visibleForTesting
class LocationTaskHandler extends TaskHandler {
  static const double minMeters = 10.0;

  Position? lastEmitted;

  @visibleForTesting
  GetPositionFn getPosition = () => Geolocator.getCurrentPosition(
    desiredAccuracy: LocationAccuracy.medium,
  );

  @override
  void onStart(DateTime timestamp, SendPort? sendPort) {}

  @override
  Future<void> onRepeatEvent(DateTime timestamp, SendPort? sendPort) async {
    Position pos;
    try {
      pos = await getPosition();
    } catch (_) {
      return;
    }

    final prev = lastEmitted;
    if (prev != null) {
      final dist = Geolocator.distanceBetween(
        prev.latitude, prev.longitude,
        pos.latitude, pos.longitude,
      );
      if (dist < minMeters) return;
    }

    lastEmitted = pos;
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
        interval: 5000,
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
