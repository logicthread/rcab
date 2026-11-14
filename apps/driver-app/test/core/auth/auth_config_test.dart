import 'dart:convert';
import 'dart:io';

import 'package:driver_app/core/auth/auth_config.dart';
import 'package:driver_app/core/auth/native_auth_contract.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final contract = jsonDecode(
    File('test/fixtures/native_auth_contract.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  group('AuthConfig', () {
    test('parses the contract body (GET /v1/auth/config)', () {
      final c = contract['config'] as Map<String, dynamic>;
      expect(c['path'], NativeAuthContract.configPath);
      final config = AuthConfig.tryParse(c['response_200'])!;
      expect(config.googleEnabled, isTrue);
      expect(config.phoneEnabled, isFalse);
      expect(config.googleClientId, '123-web.apps.googleusercontent.com');
    });

    test('null clientId and unknown methods are tolerated', () {
      final config = AuthConfig.tryParse({
        'methods': ['google', 'phone', 'sms-from-the-future', 7],
        'google': {'clientId': null},
      })!;
      expect(config.methods, {'google', 'phone', 'sms-from-the-future'});
      expect(config.googleClientId, isNull);
    });

    test('a body without methods is rejected', () {
      expect(AuthConfig.tryParse({'google': {}}), isNull);
      expect(AuthConfig.tryParse('nope'), isNull);
      expect(AuthConfig.tryParse(null), isNull);
    });
  });

  group('NativeSession', () {
    test('google session: null phone, email kept', () {
      final g = contract['google'] as Map<String, dynamic>;
      expect(g['path'], NativeAuthContract.googlePath);
      final s =
          NativeSession.tryParse(g['response_200'] as Map<String, dynamic>)!;
      expect(s.phoneE164, isNull);
      expect(s.email, 'driver@example.com');
    });

    test('phone session: phone kept, email absent', () {
      final p =
          contract['firebase_exchange']['response_200'] as Map<String, dynamic>;
      final s = NativeSession.tryParse(p)!;
      expect(s.phoneE164, '+233201234567');
      expect(s.email, isNull);
    });
  });
}
