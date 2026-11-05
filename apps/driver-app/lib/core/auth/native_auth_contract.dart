/// Native (mobile) session contract with the rcab API (R03).
///
/// Distinct from the browser flow: the refresh token travels in the JSON body
/// and is kept in secure storage, never in a cookie. Each refresh rotates the
/// token; the old one is single-use (reuse => 401).
///
/// Mirrored by test/fixtures/native_auth_contract.json.
class NativeAuthContract {
  const NativeAuthContract._();

  static const firebaseExchangePath = '/v1/auth/native/firebase-exchange';
  static const refreshPath = '/v1/auth/native/refresh';
  static const logoutPath = '/v1/auth/native/logout';
}

/// Parsed `TokenResponse` from the exchange / refresh endpoints.
class NativeSession {
  const NativeSession({
    required this.accessToken,
    required this.refreshToken,
    required this.userId,
    required this.role,
  });

  final String accessToken;
  final String refreshToken;
  final String userId;
  final String role;

  /// Returns null when [json] does not match the contract.
  static NativeSession? tryParse(Map<String, dynamic>? json) {
    if (json == null) return null;
    final access = json['access_token'];
    final refresh = json['refresh_token'];
    final user = json['user'];
    if (access is! String || access.isEmpty) return null;
    if (refresh is! String || refresh.isEmpty) return null;
    if (user is! Map<String, dynamic>) return null;
    final id = user['id'];
    if (id is! String || id.isEmpty) return null;
    return NativeSession(
      accessToken: access,
      refreshToken: refresh,
      userId: id,
      role: (user['role'] as String?) ?? 'driver',
    );
  }
}
