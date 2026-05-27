import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'auth_state.dart';
import 'token_store.dart';

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier(this._tokenStore) : super(const AuthStateUnauthenticated());

  final TokenStore _tokenStore;

  void setAuthenticated({required String userId, String role = 'driver'}) {
    state = AuthStateAuthenticated(userId: userId, role: role);
  }

  Future<void> signOut() async {
    await _tokenStore.clear();
    state = const AuthStateUnauthenticated();
  }
}
