import 'dart:async';

/// Keeps a Socket.IO connection authenticated across access-token changes.
///
/// The API checks the access token only in the handshake and answers a token it
/// rejects (expired, revoked, signed for another user) with an
/// `io server disconnect`, which socket.io never retries by itself. Capturing
/// the token once at connect time therefore broke a driver for good after the
/// 15-minute access token expired and the connection dropped: every reconnect
/// was refused, offers stopped arriving and presence was swept offline
/// (found walking the driver flows for RCAB-E8.S15).
///
/// [authFn] is the socket's `auth` option, so every handshake (first connect and
/// each automatic reconnect) sends the newest stored token. [onDisconnect]
/// recovers from a server rejection: refresh the session, wait, reconnect, at
/// most [maxAttempts] times until the next successful connect.
class SocketReauth {
  SocketReauth({
    required this.readToken,
    required this.refreshSession,
    this.maxAttempts = 3,
    this.backoff = const Duration(seconds: 1),
  });

  final Future<String?> Function() readToken;
  final Future<void> Function() refreshSession;
  final int maxAttempts;
  final Duration backoff;

  int _attempts = 0;
  bool _recovering = false;

  /// For `OptionBuilder.setAuthFn`.
  void authFn(void Function(Map<dynamic, dynamic> auth) callback) {
    unawaited(readToken().then(
      (token) => callback({'token': token ?? ''}),
      onError: (Object _) => callback({'token': ''}),
    ));
  }

  /// Call from the socket's connect handler.
  void onConnected() => _attempts = 0;

  /// Call from the socket's disconnect handler. Returns true when it scheduled
  /// a reconnect. [stillWanted] is checked after the wait so a socket the app
  /// closed meanwhile (sign-out, going offline) stays closed.
  Future<bool> onDisconnect(
    Object? reason, {
    required bool Function() stillWanted,
    required void Function() reconnect,
  }) async {
    if (reason != 'io server disconnect') return false; // transport drops retry on their own
    if (_recovering || _attempts >= maxAttempts) return false;
    _recovering = true;
    _attempts++;
    try {
      try {
        await refreshSession();
      } catch (_) {
        // Keep going: the stored token may already be fresh.
      }
      await Future<void>.delayed(backoff * _attempts);
    } finally {
      _recovering = false;
    }
    if (!stillWanted()) return false;
    reconnect();
    return true;
  }
}
