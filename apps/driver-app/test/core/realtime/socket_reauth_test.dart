import 'package:driver_app/core/realtime/socket_reauth.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  SocketReauth make({
    required List<String> calls,
    String? token = 'jwt-1',
    int maxAttempts = 3,
  }) =>
      SocketReauth(
        readToken: () async => token,
        refreshSession: () async => calls.add('refresh'),
        maxAttempts: maxAttempts,
        backoff: Duration.zero,
      );

  test('authFn sends the token read at handshake time', () async {
    var token = 'old';
    final reauth = SocketReauth(
      readToken: () async => token,
      refreshSession: () async {},
    );
    final sent = <Map<dynamic, dynamic>>[];
    reauth.authFn(sent.add);
    await pumpEventQueue();
    token = 'new';
    reauth.authFn(sent.add);
    await pumpEventQueue();
    expect(sent, [
      {'token': 'old'},
      {'token': 'new'},
    ]);
  });

  test('a server rejection refreshes the session, then reconnects', () async {
    final calls = <String>[];
    final reauth = make(calls: calls);
    final scheduled = await reauth.onDisconnect(
      'io server disconnect',
      stillWanted: () => true,
      reconnect: () => calls.add('reconnect'),
    );
    expect(scheduled, isTrue);
    expect(calls, ['refresh', 'reconnect']);
  });

  test('transport drops are left to socket.io (no refresh, no reconnect)', () async {
    final calls = <String>[];
    final reauth = make(calls: calls);
    for (final reason in ['transport close', 'ping timeout', 'io client disconnect']) {
      expect(
        await reauth.onDisconnect(reason, stillWanted: () => true, reconnect: () => calls.add('reconnect')),
        isFalse,
      );
    }
    expect(calls, isEmpty);
  });

  test('a socket the app closed meanwhile is not reopened', () async {
    final calls = <String>[];
    final reauth = make(calls: calls);
    final scheduled = await reauth.onDisconnect(
      'io server disconnect',
      stillWanted: () => false,
      reconnect: () => calls.add('reconnect'),
    );
    expect(scheduled, isFalse);
    expect(calls, ['refresh']);
  });

  test('gives up after maxAttempts until a connect succeeds', () async {
    final calls = <String>[];
    final reauth = make(calls: calls, maxAttempts: 2);
    Future<bool> reject() => reauth.onDisconnect(
          'io server disconnect',
          stillWanted: () => true,
          reconnect: () => calls.add('reconnect'),
        );
    expect(await reject(), isTrue);
    expect(await reject(), isTrue);
    expect(await reject(), isFalse);
    reauth.onConnected();
    expect(await reject(), isTrue);
  });

  test('a failing refresh still reconnects with the stored token', () async {
    final calls = <String>[];
    final reauth = SocketReauth(
      readToken: () async => 'jwt',
      refreshSession: () async => throw Exception('offline'),
      backoff: Duration.zero,
    );
    expect(
      await reauth.onDisconnect('io server disconnect', stillWanted: () => true, reconnect: () => calls.add('reconnect')),
      isTrue,
    );
    expect(calls, ['reconnect']);
  });
}
