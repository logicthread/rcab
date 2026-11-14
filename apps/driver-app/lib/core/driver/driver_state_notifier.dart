import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../api/api_error.dart';
import '../auth/token_store.dart';
import '../location/foreground_service.dart';
import '../realtime/location_bridge.dart';
import 'driver_state.dart';

class DriverStateNotifier extends StateNotifier<DriverState> {
  DriverStateNotifier({
    required Dio dio,
    required String apiBaseUrl,
    required TokenStore tokenStore,
    required ForegroundServiceManager foregroundService,
    LocationBridge? locationBridge,
    String? currentVehicleId,
    DriverState? initialState,
  })  : _dio = dio,
        _apiBaseUrl = apiBaseUrl,
        _tokenStore = tokenStore,
        _foregroundService = foregroundService,
        _locationBridge = locationBridge ?? LocationBridge(),
        _currentVehicleId = currentVehicleId,
        super(initialState ?? const DriverOffline());

  final Dio _dio;
  final String _apiBaseUrl;
  final TokenStore _tokenStore;
  final ForegroundServiceManager _foregroundService;
  final LocationBridge _locationBridge;
  String? _currentVehicleId;
  io.Socket? _socket;

  String? get currentVehicleId => _currentVehicleId;

  void updateVehicleId(String? vehicleId) {
    _currentVehicleId = vehicleId;
  }

  /// Shown when the server has no current vehicle for the driver.
  static const noVehicleMessage = 'Please select a vehicle before going online';

  /// Returns an error message if failed, null on success.
  ///
  /// The server owns the vehicle rule (`400 no_vehicle_selected` when the
  /// driver has no current vehicle). The app does not pre-check a locally
  /// cached vehicle id: on a cold start it has none even when the server does,
  /// which used to block every driver from going online (RCAB-E8.S14).
  Future<String?> goOnline({required double lat, required double lng}) async {
    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/v1/drivers/online',
        data: {'lat': lat, 'lng': lng},
      );
      final sessionId = (res.data?['session_id'] as String?) ?? '';

      await _foregroundService.startService();
      await _connectSocket();

      state = DriverOnline(vehicleId: _currentVehicleId, sessionId: sessionId);
      return null;
    } on DioException catch (e) {
      return serverErrorMessage(e, fallback: 'Failed to go online');
    } catch (e) {
      return e.toString();
    }
  }

  /// A driver-readable message for a failed API call: the server's
  /// `{error: {code, message}}` body when present, never Dio's internal description.
  static String serverErrorMessage(DioException e, {required String fallback}) {
    final err = ApiError.of(e);
    if (err?.code == 'no_vehicle_selected') return noVehicleMessage;
    if (err?.message != null) return err!.message!;
    return e.response == null ? 'Network error — check your connection' : fallback;
  }

  Future<void> goOffline() async {
    try {
      await _dio.post<void>('/v1/drivers/offline');
    } catch (_) {
      // Best-effort — still clean up locally
    }
    await _stopLocal();
  }

  /// Options for the presence socket. `forceNew` is load-bearing:
  /// socket_io_client caches one Manager per host, so without it `io.io()`
  /// handed back the *same* Socket object the app's `RealtimeSocket` owns.
  /// Its `connect()` was then a no-op, and going offline called `dispose()` on
  /// that shared socket, which cleared every offer / assignment listener: after
  /// one offline → online cycle the driver never received another offer until
  /// the app was restarted (RCAB-E8.S14).
  @visibleForTesting
  static Map<String, dynamic> socketOptions(String jwt) => io.OptionBuilder()
      .setTransports(['websocket'])
      .setAuth({'token': jwt})
      .disableAutoConnect()
      .enableForceNew()
      .build();

  Future<void> _connectSocket() async {
    final jwt = await _tokenStore.getJwt();
    if (jwt == null) return;
    _socket?.dispose();
    _socket = io.io(_apiBaseUrl, socketOptions(jwt))
      ..on('force_offline', (_) => _onForceOffline())
      ..connect();

    _locationBridge.start((data) => _socket?.emit('driver:location', data));
  }

  void _onForceOffline() {
    _stopLocal();
  }

  @visibleForTesting
  void simulateForceOffline() => _onForceOffline();

  Future<void> _stopLocal() async {
    _locationBridge.stop();
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
    await _foregroundService.stopService();
    state = const DriverOffline();
  }

  @override
  void dispose() {
    _socket?.dispose();
    super.dispose();
  }
}
