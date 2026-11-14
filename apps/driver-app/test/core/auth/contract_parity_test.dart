import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Keeps the google / config sections of the driver fixture in step with the
/// API's source-of-truth fixture (RCAB-E8.S15). The API side proves its
/// controller against it; the existing API parity spec covers the rest.
void main() {
  final apiFile = File('../api/test/fixtures/native-auth-contract.json');
  final skip = apiFile.existsSync()
      ? null
      : 'API fixture not found (running outside the monorepo)';
  final mobile = jsonDecode(
    File('test/fixtures/native_auth_contract.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  Object? shape(Object? v) {
    if (v == null) return 'null';
    if (v is List) return v.map(shape).toList();
    if (v is Map) {
      final keys = v.keys.cast<String>().toList()..sort();
      return {for (final k in keys) k: shape(v[k])};
    }
    return v.runtimeType.toString();
  }

  late Map<String, dynamic> api;
  setUpAll(() {
    if (skip != null) return;
    api = (jsonDecode(apiFile.readAsStringSync())
        as Map<String, dynamic>)['endpoints'] as Map<String, dynamic>;
  });

  test('google: path, method, request and 200 shape match the API', () {
    final a = api['google'] as Map<String, dynamic>;
    final m = mobile['google'] as Map<String, dynamic>;
    expect(m['path'], a['path']);
    expect(m['method'], a['method']);
    expect(shape(m['request']), shape((a['request'] as Map)['body']));
    final body = (a['response'] as Map)['body'] as Map;
    expect(shape(m['response_200']), shape(body));
    expect((m['response_200'] as Map)['token_type'], body['token_type']);
    expect(((m['response_200'] as Map)['user'] as Map)['phone_e164'], isNull);
  }, skip: skip);

  test('config: path, method and 200 shape match the API', () {
    final a = api['config'] as Map<String, dynamic>;
    final m = mobile['config'] as Map<String, dynamic>;
    expect(m['path'], a['path']);
    expect(m['method'], a['method']);
    expect(shape(m['response_200']), shape((a['response'] as Map)['body']));
  }, skip: skip);

  test('exchange / refresh user keys include email', () {
    for (final k in ['firebase_exchange', 'refresh']) {
      final user = ((mobile[k] as Map)['response_200'] as Map)['user'] as Map;
      expect(user.keys.toList()..sort(), ['email', 'id', 'phone_e164', 'role']);
      final apiUser =
          (((api[k] as Map)['response'] as Map)['body'] as Map)['user'] as Map;
      expect(user.keys.toList()..sort(), apiUser.keys.toList()..sort());
    }
  }, skip: skip);

  test('error codes the app has copy for exist in the API fixture', () {
    final raw =
        (jsonDecode(apiFile.readAsStringSync()) as Map)['errors'] as Map;
    final codes = (mobile['error_codes'] as Map).cast<String, int>();
    for (final e in codes.entries) {
      // Listed as account_disabled_on_* in the API fixture.
      if (e.key == 'account_disabled') {
        continue;
      }
      expect(raw[e.key]['status'], e.value, reason: e.key);
    }
  }, skip: skip);
}
