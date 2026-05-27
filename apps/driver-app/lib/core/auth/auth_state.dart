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
  });

  final String userId;
  final String role;
}
