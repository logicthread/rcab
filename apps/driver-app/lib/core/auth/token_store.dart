import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class TokenStore {
  TokenStore({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  static const _kJwtKey = 'rcab_jwt';
  static const _kRefreshKey = 'rcab_refresh_token';

  Future<void> saveTokens({
    required String jwt,
    required String refresh,
  }) async {
    await Future.wait([
      _storage.write(key: _kJwtKey, value: jwt),
      _storage.write(key: _kRefreshKey, value: refresh),
    ]);
  }

  Future<String?> getJwt() => _storage.read(key: _kJwtKey);

  Future<String?> getRefresh() => _storage.read(key: _kRefreshKey);

  Future<void> clear() async {
    await Future.wait([
      _storage.delete(key: _kJwtKey),
      _storage.delete(key: _kRefreshKey),
    ]);
  }
}
