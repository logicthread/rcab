/// Sealed auth state. Full user DTO (freezed) is added in RCAB-E3.S2.
sealed class AuthState {
  const AuthState();
}

class AuthStateUnauthenticated extends AuthState {
  const AuthStateUnauthenticated();
}

class AuthStateAuthenticated extends AuthState {
  const AuthStateAuthenticated({
    required this.userId,
    this.role = 'driver',
    this.email,
    this.phoneE164,
  });

  final String userId;
  final String role;

  /// Account label shown in the profile. Google accounts have an email and no
  /// phone (RCAB-E8.S15); phone accounts the reverse. Either may be null,
  /// e.g. after a cold start on a build that never stored it.
  final String? email;
  final String? phoneE164;

  /// What to show as "who is signed in": the email when there is one, else
  /// the phone. Null when neither is known.
  String? get accountLabel => email ?? phoneE164;
}
