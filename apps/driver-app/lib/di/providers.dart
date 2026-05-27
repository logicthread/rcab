import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/auth/auth_notifier.dart';
import '../core/auth/auth_state.dart';
import '../core/auth/token_store.dart';
import '../core/api/api_client.dart';
import '../features/profile/models/vehicle.dart';

// ── Token store ───────────────────────────────────────────────────────────────

final tokenStoreProvider = Provider<TokenStore>((ref) => TokenStore());

// ── Firebase ──────────────────────────────────────────────────────────────────

final firebaseAuthProvider = Provider<FirebaseAuth>(
  (ref) => FirebaseAuth.instance,
);

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

/// Plain Dio with only the base URL — no JWT interceptor.
///
/// Used for unauthenticated endpoints (e.g. firebase-exchange) to avoid a
/// circular provider dependency between [authProvider] and [apiClientProvider].
final _exchangeDioProvider = Provider<Dio>(
  (ref) => Dio(BaseOptions(baseUrl: _kApiBaseUrl)),
);

/// Full API client with JWT attach + transparent token refresh.
final apiClientProvider = Provider<Dio>((ref) {
  return buildApiClient(
    baseUrl: _kApiBaseUrl,
    tokenStore: ref.read(tokenStoreProvider),
    onSignOut: () => ref.read(authProvider.notifier).signOut(),
    enableLogging: _kEnableLogging,
  );
});

// ── Auth ──────────────────────────────────────────────────────────────────────

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(
    ref.read(tokenStoreProvider),
    ref.read(firebaseAuthProvider),
    ref.read(_exchangeDioProvider),
  );
});

// ── Vehicles ──────────────────────────────────────────────────────────────────

final vehiclesProvider = FutureProvider<List<Vehicle>>((ref) async {
  final dio = ref.read(apiClientProvider);
  final res = await dio.get<List<dynamic>>('/v1/vehicles');
  return (res.data ?? [])
      .map((e) => Vehicle.fromJson(e as Map<String, dynamic>))
      .toList();
});
