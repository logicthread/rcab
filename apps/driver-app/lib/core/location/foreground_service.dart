import 'dart:isolate';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

// Top-level task callback required by flutter_foreground_task.
// Location streaming is wired in RCAB-E3.S5; this is a stub.
@pragma('vm:entry-point')
void _taskCallback() {
  FlutterForegroundTask.setTaskHandler(_StubTaskHandler());
}

class _StubTaskHandler extends TaskHandler {
  @override
  void onStart(DateTime timestamp, SendPort? sendPort) {}

  @override
  void onRepeatEvent(DateTime timestamp, SendPort? sendPort) {}

  @override
  void onDestroy(DateTime timestamp, SendPort? sendPort) {}
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
      callback: _taskCallback,
    );
  }

  Future<void> stopService() async {
    await FlutterForegroundTask.stopService();
  }
}
