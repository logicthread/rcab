import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/core/driver/driver_state.dart';
import 'package:driver_app/core/driver/driver_state_notifier.dart';
import 'package:driver_app/core/location/foreground_service.dart';

// ---------------------------------------------------------------------------
// Fakes & mocks
// ---------------------------------------------------------------------------

class MockDio extends Mock implements Dio {}

class _FakeTokenStore extends TokenStore {
  final String? _jwt;
  _FakeTokenStore({String? jwt}) : _jwt = jwt;

  @override
  Future<String?> getJwt() async => _jwt;
}

class _FakeForegroundService extends ForegroundServiceManager {
  bool started = false;
  bool stopped = false;

  @override
  Future<void> startService() async => started = true;

  @override
  Future<void> stopService() async {
    started = false;
    stopped = true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

DriverStateNotifier _makeNotifier({
  MockDio? dio,
  String? vehicleId,
  DriverState? initialState,
  _FakeForegroundService? foregroundService,
  String? jwt,
}) {
  return DriverStateNotifier(
    dio: dio ?? MockDio(),
    apiBaseUrl: 'http://localhost:3000',
    tokenStore: _FakeTokenStore(jwt: jwt ?? 'test-jwt'),
    foregroundService: foregroundService ?? _FakeForegroundService(),
    currentVehicleId: vehicleId,
    initialState: initialState,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  setUpAll(() {
    registerFallbackValue(RequestOptions(path: ''));
  });

  group('DriverStateNotifier', () {
    test('initial state is DriverOffline', () {
      final notifier = _makeNotifier();
      expect(notifier.state, isA<DriverOffline>());
    });

    test('goOnline transitions offline → online on API success', () async {
      final mockDio = MockDio();
      when(() => mockDio.post<Map<String, dynamic>>(
            any(),
            data: any(named: 'data'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
            onSendProgress: any(named: 'onSendProgress'),
            onReceiveProgress: any(named: 'onReceiveProgress'),
          )).thenAnswer((_) async => Response(
            data: {'ok': true, 'session_id': 'sess-123'},
            requestOptions: RequestOptions(path: '/v1/drivers/online'),
            statusCode: 201,
          ));

      final notifier = _makeNotifier(dio: mockDio, vehicleId: 'v1');

      final error = await notifier.goOnline(lat: 12.9, lng: 77.5);

      expect(error, isNull);
      expect(notifier.state, isA<DriverOnline>());
      expect((notifier.state as DriverOnline).vehicleId, 'v1');
      expect((notifier.state as DriverOnline).sessionId, 'sess-123');
    });

    test('goOnline returns error message when currentVehicleId is null', () async {
      final notifier = _makeNotifier(vehicleId: null);

      final error = await notifier.goOnline(lat: 0, lng: 0);

      expect(error, 'Please select a vehicle before going online');
      expect(notifier.state, isA<DriverOffline>());
    });

    test('goOnline starts the foreground service on success', () async {
      final mockDio = MockDio();
      final fakeFg = _FakeForegroundService();

      when(() => mockDio.post<Map<String, dynamic>>(
            any(),
            data: any(named: 'data'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
            onSendProgress: any(named: 'onSendProgress'),
            onReceiveProgress: any(named: 'onReceiveProgress'),
          )).thenAnswer((_) async => Response(
            data: {'ok': true, 'session_id': 'sess-abc'},
            requestOptions: RequestOptions(path: '/v1/drivers/online'),
            statusCode: 201,
          ));

      final notifier = _makeNotifier(
        dio: mockDio,
        vehicleId: 'v1',
        foregroundService: fakeFg,
      );

      await notifier.goOnline(lat: 0, lng: 0);
      expect(fakeFg.started, isTrue);
    });

    test('goOffline transitions online → offline and stops foreground service', () async {
      final mockDio = MockDio();
      final fakeFg = _FakeForegroundService();

      when(() => mockDio.post<void>(
            any(),
            data: any(named: 'data'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
            onSendProgress: any(named: 'onSendProgress'),
            onReceiveProgress: any(named: 'onReceiveProgress'),
          )).thenAnswer((_) async => Response(
            data: null,
            requestOptions: RequestOptions(path: '/v1/drivers/offline'),
            statusCode: 200,
          ));

      final notifier = _makeNotifier(
        dio: mockDio,
        vehicleId: 'v1',
        initialState: const DriverOnline(vehicleId: 'v1', sessionId: 's1'),
        foregroundService: fakeFg,
      );

      await notifier.goOffline();

      expect(notifier.state, isA<DriverOffline>());
      expect(fakeFg.stopped, isTrue);
    });

    test('force_offline event triggers offline transition and stops service', () async {
      final fakeFg = _FakeForegroundService();
      final notifier = _makeNotifier(
        vehicleId: 'v1',
        initialState: const DriverOnline(vehicleId: 'v1', sessionId: 's1'),
        foregroundService: fakeFg,
      );

      // Simulate the force_offline socket event firing
      notifier.simulateForceOffline();

      // Allow async _stopLocal to run
      await Future<void>.delayed(Duration.zero);

      expect(notifier.state, isA<DriverOffline>());
      expect(fakeFg.stopped, isTrue);
    });
  });
}
