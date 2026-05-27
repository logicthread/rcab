import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../auth/token_store.dart';
import '../location/foreground_service.dart';
import 'driver_state.dart';

class DriverStateNotifier extends StateNotifier<DriverState> {
  DriverStateNotifier({
    required Dio dio,
    required String apiBaseUrl,
    required TokenStore tokenStore,
    required ForegroundServiceManager foregroundService,
    String? currentVehicleId,
    DriverState? initialState,
  })  : _dio = dio,
        _apiBaseUrl = apiBaseUrl,
        _tokenStore = tokenStore,
        _foregroundService = foregroundService,
        _currentVehicleId = currentVehicleId,
        super(initialState ?? const DriverOffline());

  final Dio _dio;
  final String _apiBaseUrl;
  final TokenStore _tokenStore;
  final ForegroundServiceManager _foregroundService;
  String? _currentVehicleId;
  io.Socket? _socket;

  String? get currentVehicleId => _currentVehicleId;

  void updateVehicleId(String? vehicleId) {
    _currentVehicleId = vehicleId;
  }

  /// Returns an error message if failed, null on success.
  Future<String?> goOnline({required double lat, required double lng}) async {
    if (_currentVehicleId == null) {
      return 'Please select a vehicle before going online';
    }

    try {
      final res = await _dio.post<Map<String, dynamic>>(
        '/v1/drivers/online',
        data: {'lat': lat, 'lng': lng},
      );
      final sessionId = (res.data?['session_id'] as String?) ?? '';

      await _foregroundService.startService();
      await _connectSocket();

      state = DriverOnline(vehicleId: _currentVehicleId!, sessionId: sessionId);
      return null;
    } on DioException catch (e) {
      return e.message ?? 'Failed to go online';
    } catch (e) {
      return e.toString();
    }
  }

  Future<void> goOffline() async {
    try {
      await _dio.post<void>('/v1/drivers/offline');
    } catch (_) {
      // Best-effort — still clean up locally
    }
    await _stopLocal();
  }

  Future<void> _connectSocket() async {
    final jwt = await _tokenStore.getJwt();
    if (jwt == null) return;
    _socket = io.io(
      _apiBaseUrl,
      io.OptionBuilder()
          .setTransports(['websocket'])
          .setAuth({'token': jwt})
          .disableAutoConnect()
          .build(),
    )
      ..on('force_offline', (_) => _onForceOffline())
      ..connect();
  }

  void _onForceOffline() {
    _stopLocal();
  }

  @visibleForTesting
  void simulateForceOffline() => _onForceOffline();

  Future<void> _stopLocal() async {
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
