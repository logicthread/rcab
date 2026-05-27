import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/auth/auth_notifier.dart';
import '../core/auth/auth_state.dart';
import '../core/auth/token_store.dart';
import '../core/api/api_client.dart';

// ── Token store ───────────────────────────────────────────────────────────────

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore());

// ── Auth ──────────────────────────────────────────────────────────────────────

final authProvider =
    StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(ref.read(tokenStoreProvider));
});

// ── API client ────────────────────────────────────────────────────────────────

/// Injected at build time: `--dart-define=API_BASE_URL=<url>`
/// Dev default targets the Android emulator host.
const _kApiBaseUrl = String.fromEnvironment(
  'API_BASE_URL',
  defaultValue: 'http://10.0.2.2:3000',
);

/// Whether verbose dio logging is enabled.
/// True in debug builds; false in release / profile.
const _kEnableLogging = bool.fromEnvironment(
  'ENABLE_API_LOGGING',
  defaultValue: true,
);

final apiClientProvider = Provider<Dio>((ref) {
  return buildApiClient(
    baseUrl: _kApiBaseUrl,
    tokenStore: ref.read(tokenStoreProvider),
    onSignOut: () => ref.read(authProvider.notifier).signOut(),
    enableLogging: _kEnableLogging,
  );
});
