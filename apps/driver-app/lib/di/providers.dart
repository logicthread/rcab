import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../core/auth/auth_config.dart';
import '../core/auth/auth_notifier.dart';
import '../core/auth/native_auth_contract.dart';
import '../core/auth/auth_state.dart';
import '../core/auth/token_store.dart';
import '../core/api/api_client.dart';
import '../core/driver/driver_state.dart';
import '../core/driver/driver_state_notifier.dart';
import '../core/location/driver_locator.dart';
import '../core/location/foreground_service.dart';
import '../core/realtime/realtime_socket.dart';
import '../features/profile/models/vehicle.dart';
import '../features/shared_ride/shared_ride_provider.dart';

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

/// Web OAuth client id fallback for builds whose API reports none:
/// `--dart-define=GOOGLE_SERVER_CLIENT_ID=<web client id>`. The API's
/// `GET /v1/auth/config` value wins when present.
const kGoogleServerClientIdFallback =
    String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID');

/// Enabled sign-in methods + the Google web client id (RCAB-E8.S15).
/// Public endpoint, so the plain Dio is used. Invalidate to retry.
final authConfigProvider = FutureProvider.autoDispose<AuthConfig>((ref) async {
  final res = await ref.read(_exchangeDioProvider).get<dynamic>(
        NativeAuthContract.configPath,
        options: Options(
          sendTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
        ),
      );
  final config = AuthConfig.tryParse(res.data);
  if (config == null) throw const FormatException('bad /v1/auth/config body');
  return config;
});

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(
    ref.read(tokenStoreProvider),
    ref.read(firebaseAuthProvider),
    ref.read(_exchangeDioProvider),
  );
});

// ── Driver state ──────────────────────────────────────────────────────────────

final _foregroundServiceProvider = Provider<ForegroundServiceManager>(
  (_) => ForegroundServiceManager(),
);

final driverStateProvider =
    StateNotifierProvider<DriverStateNotifier, DriverState>((ref) {
  return DriverStateNotifier(
    dio: ref.read(apiClientProvider),
    apiBaseUrl: _kApiBaseUrl,
    tokenStore: ref.read(tokenStoreProvider),
    foregroundService: ref.read(_foregroundServiceProvider),
    refreshSession: () => ref.read(authProvider.notifier).refreshSession(),
  );
});

// ── Go-online position (permission + fix) ─────────────────────────────────────

final driverLocatorProvider = Provider<DriverLocator>((_) => DriverLocator());

// ── Location stream (local UI position dot) ───────────────────────────────────

/// Wraps Geolocator.getPositionStream for UI widgets (e.g. future map dot).
/// The foreground task uses one-shot getCurrentPosition to keep battery use deterministic.
final locationStreamProvider = StreamProvider<Position>((ref) {
  return Geolocator.getPositionStream(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.medium,
      distanceFilter: 0,
    ),
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

// ── Realtime socket + shared-ride wiring (RCAB-E5.S7) ─────────────────────────

final realtimeSocketProvider = Provider<IRealtimeSocket>((ref) {
  final socket = RealtimeSocket(
    apiBaseUrl: _kApiBaseUrl,
    tokenStore: ref.read(tokenStoreProvider),
    refreshSession: () => ref.read(authProvider.notifier).refreshSession(),
  );
  ref.onDispose(socket.dispose);
  return socket;
});

final sharedRideSenderOverride =
    sharedRideSenderProvider.overrideWith((ref) => ref.watch(realtimeSocketProvider));
