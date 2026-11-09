import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

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

    test('goOnline surfaces the server no_vehicle_selected rule', () async {
      final mockDio = MockDio();
      final req = RequestOptions(path: '/v1/drivers/online');
      when(() => mockDio.post<Map<String, dynamic>>(
            any(),
            data: any(named: 'data'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
            onSendProgress: any(named: 'onSendProgress'),
            onReceiveProgress: any(named: 'onReceiveProgress'),
          )).thenThrow(DioException(
        requestOptions: req,
        response: Response(
          requestOptions: req,
          statusCode: 400,
          // The real API envelope (AppExceptionFilter); the server's own text
          // differs from the app's so the test proves the code is recognised.
          data: {
            'error': {'code': 'no_vehicle_selected', 'message': 'no current vehicle', 'request_id': 'r-1'},
          },
        ),
        type: DioExceptionType.badResponse,
      ));
      final notifier = _makeNotifier(dio: mockDio, vehicleId: null);

      final error = await notifier.goOnline(lat: 26.19, lng: 91.82);

      expect(error, DriverStateNotifier.noVehicleMessage);
      expect(notifier.state, isA<DriverOffline>());
    });

    // Regression (RCAB-E8.S14): the local vehicle id is never known on a cold
    // start, and a client-side pre-check blocked every driver from going online
    // even though the server had a current vehicle.
    test('goOnline does not require a locally known vehicle id', () async {
      final mockDio = MockDio();
      when(() => mockDio.post<Map<String, dynamic>>(
            any(),
            data: any(named: 'data'),
            options: any(named: 'options'),
            cancelToken: any(named: 'cancelToken'),
            onSendProgress: any(named: 'onSendProgress'),
            onReceiveProgress: any(named: 'onReceiveProgress'),
          )).thenAnswer((_) async => Response(
            data: {'ok': true, 'session_id': 'sess-cold'},
            requestOptions: RequestOptions(path: '/v1/drivers/online'),
            statusCode: 201,
          ));
      final notifier = _makeNotifier(dio: mockDio, vehicleId: null);

      final error = await notifier.goOnline(lat: 26.19, lng: 91.82);

      expect(error, isNull);
      expect(notifier.state, isA<DriverOnline>());
      expect((notifier.state as DriverOnline).vehicleId, isNull);
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

  // Regression (RCAB-E8.S14): socket_io_client caches one Manager per host, so
  // the presence socket used to be the very Socket the app's RealtimeSocket
  // owns; going offline disposed it and cleared every offer listener.
  group('presence socket', () {
    const url = 'http://10.0.2.2:39999';

    test('is a separate Socket from one already open to the same host', () {
      final app = io.io(
        url,
        io.OptionBuilder().setTransports(['websocket']).disableAutoConnect().build(),
      );
      final presence = io.io(url, DriverStateNotifier.socketOptions('jwt'));
      addTearDown(() {
        presence.dispose();
        app.dispose();
      });

      expect(identical(app, presence), isFalse);
      expect(identical(app.io, presence.io), isFalse);
    });

    test('disposing the presence socket leaves the app socket listeners intact', () {
      final app = io.io(
        url,
        io.OptionBuilder().setTransports(['websocket']).disableAutoConnect().build(),
      )..on('ride_offer', (_) {});
      addTearDown(app.dispose);

      io.io(url, DriverStateNotifier.socketOptions('jwt')).dispose();

      expect(app.hasListeners('ride_offer'), isTrue);
    });
  });
}
