/// Which sign-in methods the API has switched on (`GET /v1/auth/config`,
/// RCAB-E8.S15). The client renders only these.
///
/// Wire shape: `{"methods":["google"],"google":{"clientId":"<web client id>"|null}}`.
class AuthConfig {
  const AuthConfig({required this.methods, this.googleClientId});

  static const google = 'google';
  static const phone = 'phone';

  final Set<String> methods;

  /// The web OAuth client id the Android app passes as `serverClientId` so
  /// the ID token's audience is one the API accepts. Null when the API has
  /// none configured.
  final String? googleClientId;

  bool get googleEnabled => methods.contains(google);
  bool get phoneEnabled => methods.contains(phone);

  /// Returns null when [json] does not match the contract.
  static AuthConfig? tryParse(Object? json) {
    if (json is! Map) return null;
    final methods = json['methods'];
    if (methods is! List) return null;
    final googleBlock = json['google'];
    final clientId = googleBlock is Map ? googleBlock['clientId'] : null;
    return AuthConfig(
      methods: methods.whereType<String>().toSet(),
      googleClientId:
          clientId is String && clientId.isNotEmpty ? clientId : null,
    );
  }
}
