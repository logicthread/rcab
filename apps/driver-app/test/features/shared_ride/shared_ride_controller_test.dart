import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/core/realtime/realtime_socket.dart';
import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/shared_ride/shared_ride_controller.dart';
import 'package:driver_app/features/shared_ride/shared_ride_models.dart';
import 'package:driver_app/features/shared_ride/shared_ride_provider.dart';

class _FakeSocket implements IRealtimeSocket {
  final _rideOffer = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideOfferAccepted = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideOfferRevoked = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _stopPickup = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _stopDrop = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _rideCompleted = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final _driverState = StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final List<({String event, Map<String, dynamic> data})> sent = [];

  @override
  Stream<Map<String, dynamic>> get rideOffer => _rideOffer.stream;
  @override
  Stream<Map<String, dynamic>> get rideOfferAccepted => _rideOfferAccepted.stream;
  @override
  Stream<Map<String, dynamic>> get rideOfferRevoked => _rideOfferRevoked.stream;
  @override
  Stream<Map<String, dynamic>> get stopPickupConfirmed => _stopPickup.stream;
  @override
  Stream<Map<String, dynamic>> get stopDropConfirmed => _stopDrop.stream;
  @override
  Stream<Map<String, dynamic>> get rideCompleted => _rideCompleted.stream;
  @override
  Stream<Map<String, dynamic>> get driverState => _driverState.stream;

  @override
  Future<void> connect() async {}
  @override
  void disconnect() {}

  @override
  void sendOfferResponse({required String offerId, required bool accept}) {
    sent.add((event: 'ride_offer_response', data: {'offerId': offerId, 'accept': accept}));
  }

  @override
  void sendPickupConfirmed({required String rideId, required int sequenceIndex}) {
    sent.add((event: 'stop:pickup_confirmed', data: {'rideId': rideId, 'sequenceIndex': sequenceIndex}));
  }

  @override
  void sendDropConfirmed({required String rideId, required int sequenceIndex}) {
    sent.add((event: 'stop:drop_confirmed', data: {'rideId': rideId, 'sequenceIndex': sequenceIndex}));
  }

  @override
  Future<void> dispose() async {
    await Future.wait([
      _rideOffer.close(), _rideOfferAccepted.close(), _rideOfferRevoked.close(),
      _stopPickup.close(), _stopDrop.close(),
      _rideCompleted.close(), _driverState.close(),
    ]);
  }

  void emitRideOffer(Map<String, dynamic> p) => _rideOffer.add(p);
  void emitStopPickup(Map<String, dynamic> p) => _stopPickup.add(p);
  void emitStopDrop(Map<String, dynamic> p) => _stopDrop.add(p);
  void emitRideCompleted(Map<String, dynamic> p) => _rideCompleted.add(p);
  void emitDriverState(Map<String, dynamic> p) => _driverState.add(p);
}

class _StubDio implements Dio {
  _StubDio(this.stopsByRide);
  final Map<String, List<Map<String, dynamic>>> stopsByRide;

  @override
  Future<Response<T>> get<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    Options? options,
    CancelToken? cancelToken,
    ProgressCallback? onReceiveProgress,
  }) async {
    final m = RegExp(r'^/v1/rides/(.+)/stops$').firstMatch(path);
    if (m != null) {
      final rideId = m.group(1)!;
      final stops = stopsByRide[rideId] ?? const <Map<String, dynamic>>[];
      return Response<T>(
        requestOptions: RequestOptions(path: path),
        statusCode: 200,
        data: {'rideId': rideId, 'poolStatus': 'closed_full', 'stops': stops} as T,
      );
    }
    throw UnimplementedError('Stub does not handle $path');
  }

  @override
  noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

({ProviderContainer container, _FakeSocket socket, List<String> navStack, SharedRideController ctrl}) _make({Dio? dio}) {
  final socket = _FakeSocket();
  final container = ProviderContainer(overrides: [
    realtimeSocketProvider.overrideWithValue(socket),
    sharedRideSenderProvider.overrideWithValue(socket),
  ]);
  final navStack = <String>[];
  final ctrl = SharedRideController(
    container: container,
    navigate: navStack.add,
    dio: dio ?? _StubDio(const {}),
  );
  return (container: container, socket: socket, navStack: navStack, ctrl: ctrl);
}

void main() {
  group('SharedRideController.ride_offer routing', () {
    test('parses shared offer + navigates to /shared-ride/:id + applies offer', () async {
      final h = _make();
      await h.ctrl.start();

      h.socket.emitRideOffer({
        'offerId': 'o-1',
        'sharedRideId': 'ride-1',
        'passengerCount': 2,
        'stops': [
          {'sequenceIndex': 0, 'passengerId': 'pa', 'type': 'pickup',  'lat': 0.0, 'lng': 0.0},
          {'sequenceIndex': 1, 'passengerId': 'pa', 'type': 'dropoff', 'lat': 0.0, 'lng': 0.0},
        ],
      });
      await Future<void>.delayed(Duration.zero);

      expect(h.container.read(sharedRideProvider).sharedRideId, 'ride-1');
      expect(h.navStack, ['/shared-ride/ride-1']);
    });

    test('ignores solo offers (no stops array)', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitRideOffer({'offerId': 'o', 'pickup': {'lat': 0, 'lng': 0}});
      await Future<void>.delayed(Duration.zero);
      expect(h.container.read(sharedRideProvider).sharedRideId, isNull);
      expect(h.navStack, isEmpty);
    });
  });

  group('SharedRideController.driver_state reconnect restore', () {
    test('hydrates from GET /v1/rides/:id/stops + navigates to /shared-ride/:id', () async {
      final stubDio = _StubDio({
        'ride-restored': [
          {
            'sequenceIndex': 0, 'passengerId': 'pa', 'type': 'pickup',
            'lat': 0.0, 'lng': 0.0, 'confirmed': true,
            'confirmedAt': '2026-05-29T12:00:00.000Z',
          },
          {
            'sequenceIndex': 1, 'passengerId': 'pa', 'type': 'dropoff',
            'lat': 0.0, 'lng': 0.0, 'confirmed': false, 'confirmedAt': null,
          },
        ],
      });
      final h = _make(dio: stubDio);
      await h.ctrl.start();

      h.socket.emitDriverState({'availability': 'online', 'current_ride_id': 'ride-restored'});
      await Future<void>.delayed(const Duration(milliseconds: 10));

      final state = h.container.read(sharedRideProvider);
      expect(state.sharedRideId, 'ride-restored');
      expect(state.stops.length, 2);
      expect(state.currentStopIndex, 1);
      expect(h.navStack, ['/shared-ride/ride-restored']);
    });

    test('no-op when current_ride_id is null', () async {
      final h = _make();
      await h.ctrl.start();
      h.socket.emitDriverState({'availability': 'online', 'current_ride_id': null});
      await Future<void>.delayed(Duration.zero);
      expect(h.container.read(sharedRideProvider).sharedRideId, isNull);
      expect(h.navStack, isEmpty);
    });
  });

  group('SharedRideController stop echo handling', () {
    test('applies pickup echo to advance currentStopIndex', () async {
      final h = _make();
      await h.ctrl.start();
      h.container.read(sharedRideProvider.notifier).applyOffer(const SharedRideOffer(
        sharedRideId: 'ride-1',
        passengerCount: 1,
        stops: [
          SharedRideStop(sequenceIndex: 0, passengerId: 'p', type: StopType.pickup,  lat: 0, lng: 0),
          SharedRideStop(sequenceIndex: 1, passengerId: 'p', type: StopType.dropoff, lat: 0, lng: 0),
        ],
      ));

      h.socket.emitStopPickup({
        'rideId': 'ride-1', 'sequenceIndex': 0,
        'confirmedAt': '2026-05-29T12:00:00.000Z', 'rideCompleted': false,
      });
      await Future<void>.delayed(Duration.zero);

      expect(h.container.read(sharedRideProvider).currentStopIndex, 1);
    });

    test('drop echo with rideCompleted=true flips completed state', () async {
      final h = _make();
      await h.ctrl.start();
      h.container.read(sharedRideProvider.notifier).applyOffer(const SharedRideOffer(
        sharedRideId: 'ride-1',
        passengerCount: 1,
        stops: [
          SharedRideStop(sequenceIndex: 0, passengerId: 'p', type: StopType.pickup,  lat: 0, lng: 0),
          SharedRideStop(sequenceIndex: 1, passengerId: 'p', type: StopType.dropoff, lat: 0, lng: 0),
        ],
      ));

      h.socket.emitStopPickup({
        'rideId': 'ride-1', 'sequenceIndex': 0,
        'confirmedAt': '2026-05-29T12:00:00.000Z', 'rideCompleted': false,
      });
      h.socket.emitStopDrop({
        'rideId': 'ride-1', 'sequenceIndex': 1,
        'confirmedAt': '2026-05-29T12:05:00.000Z', 'rideCompleted': true,
      });
      await Future<void>.delayed(Duration.zero);

      expect(h.container.read(sharedRideProvider).completed, isTrue);
    });
  });
}
