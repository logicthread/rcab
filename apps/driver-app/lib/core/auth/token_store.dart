import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class TokenStore {
  TokenStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  static const _kJwtKey = 'rcab_jwt';
  static const _kRefreshKey = 'rcab_refresh_token';
  static const _kEmailKey = 'rcab_account_email';
  static const _kPhoneKey = 'rcab_account_phone';

  Future<void> saveTokens({
    required String jwt,
    required String refresh,
  }) async {
    await Future.wait([
      _storage.write(key: _kJwtKey, value: jwt),
      _storage.write(key: _kRefreshKey, value: refresh),
    ]);
  }

  /// Remembers who is signed in so the profile can show it after a cold
  /// start (the access token carries no email). Display only; never a
  /// credential.
  Future<void> saveAccount({String? email, String? phoneE164}) async {
    await Future.wait([
      email == null
          ? _storage.delete(key: _kEmailKey)
          : _storage.write(key: _kEmailKey, value: email),
      phoneE164 == null
          ? _storage.delete(key: _kPhoneKey)
          : _storage.write(key: _kPhoneKey, value: phoneE164),
    ]);
  }

  Future<({String? email, String? phoneE164})> getAccount() async {
    final email = await _storage.read(key: _kEmailKey);
    final phone = await _storage.read(key: _kPhoneKey);
    return (email: email, phoneE164: phone);
  }

  Future<String?> getJwt() => _storage.read(key: _kJwtKey);

  Future<String?> getRefresh() => _storage.read(key: _kRefreshKey);

  Future<void> clear() async {
    await Future.wait([
      _storage.delete(key: _kJwtKey),
      _storage.delete(key: _kRefreshKey),
      _storage.delete(key: _kEmailKey),
      _storage.delete(key: _kPhoneKey),
    ]);
  }
}
