import 'dart:async';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

/// Bridges location data from the foreground task isolate to the main isolate.
///
/// The foreground task sends {lat, lng, heading, speed} via SendPort.send().
/// This class listens on FlutterForegroundTask.receivePort and forwards each
/// message to the provided [onLocation] callback, which calls socket.emit().
class LocationBridge {
  StreamSubscription<dynamic>? _sub;

  void start(void Function(Map<String, dynamic> data) onLocation) {
    _sub?.cancel();
    final port = FlutterForegroundTask.receivePort;
    if (port == null) return;
    _sub = port.listen((dynamic raw) {
      if (raw is Map<String, dynamic>) onLocation(raw);
    });
  }

  void stop() {
    _sub?.cancel();
    _sub = null;
  }
}
