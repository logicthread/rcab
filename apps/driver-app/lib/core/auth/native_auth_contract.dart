/// Native (mobile) session contract with the rcab API (R03).
///
/// Distinct from the browser flow: the refresh token travels in the JSON body
/// and is kept in secure storage, never in a cookie. Each refresh rotates the
/// token; the old one is single-use (reuse => 401).
///
/// Mirrored by test/fixtures/native_auth_contract.json.
class NativeAuthContract {
  const NativeAuthContract._();

  /// Public, unauthenticated: which sign-in methods are on (RCAB-E8.S15).
  static const configPath = '/v1/auth/config';
  static const firebaseExchangePath = '/v1/auth/native/firebase-exchange';

  /// Google ID token -> rcab session (RCAB-E8.S15). Same response shape as
  /// the Firebase exchange.
  static const googlePath = '/v1/auth/native/google';
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
    this.email,
    this.phoneE164,
  });

  final String accessToken;
  final String refreshToken;
  final String userId;
  final String role;

  /// Verified Google email; null for phone-only accounts.
  final String? email;

  /// Null for accounts registered through Google (`phone_e164` is nullable
  /// since RCAB-E8.S15).
  final String? phoneE164;

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
      email: _nonEmpty(user['email']),
      phoneE164: _nonEmpty(user['phone_e164']),
    );
  }

  static String? _nonEmpty(Object? v) => v is String && v.isNotEmpty ? v : null;
}
