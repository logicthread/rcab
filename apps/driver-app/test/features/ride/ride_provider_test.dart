import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/features/ride/ride_models.dart';
import 'package:driver_app/features/ride/ride_provider.dart';

class _FakeRideService implements RideService {
  RideDetail? detail;
  String? advanceResult;
  Object? getError;
  Object? advanceError;
  int getCalls = 0;
  final List<({String rideId, String event})> advanceCalls = [];

  @override
  Future<RideDetail> getRide(String rideId) async {
    getCalls++;
    if (getError != null) throw getError!;
    return detail!;
  }

  @override
  Future<String> advance(String rideId, String event) async {
    advanceCalls.add((rideId: rideId, event: event));
    if (advanceError != null) throw advanceError!;
    return advanceResult!;
  }
}

RideDetail _detail(String status) => RideDetail(
      rideId: 'r-1',
      status: status,
      originLat: 26.14,
      originLng: 91.73,
      destLat: 26.18,
      destLng: 91.75,
    );

void main() {
  group('RideStatus', () {
    test('drives the next event, label, and navigation heading', () {
      expect(RideStatus.accepted.nextEvent, 'start_en_route');
      expect(RideStatus.accepted.actionLabel, 'Start trip');
      expect(RideStatus.accepted.isHeadingToDropoff, isFalse);
      expect(RideStatus.enRoute.nextEvent, 'mark_arrived');
      expect(RideStatus.arrived.nextEvent, 'start_ride');
      expect(RideStatus.inProgress.nextEvent, 'end_ride');
      expect(RideStatus.inProgress.isHeadingToDropoff, isTrue);
      expect(RideStatus.completed.nextEvent, isNull);
      expect(RideStatus.completed.actionLabel, isNull);
    });

    test('parse maps wire values and falls back to unknown', () {
      expect(RideStatus.parse('en_route'), RideStatus.enRoute);
      expect(RideStatus.parse('in_progress'), RideStatus.inProgress);
      expect(RideStatus.parse('weird'), RideStatus.unknown);
      expect(RideStatus.parse(null), RideStatus.unknown);
    });
  });

  group('RideState', () {
    test('navLat/navLng follow the heading (pickup before aboard, dropoff after)', () {
      const s = RideState(
        rideId: 'r-1',
        status: RideStatus.arrived,
        originLat: 1,
        originLng: 2,
        destLat: 3,
        destLng: 4,
      );
      expect(s.navLat, 1);
      expect(s.navLng, 2);
      final aboard = s.copyWith(status: RideStatus.inProgress);
      expect(aboard.navLat, 3);
      expect(aboard.navLng, 4);
    });
  });

  group('RideNotifier', () {
    test('load hydrates status + coords + loaded', () async {
      final svc = _FakeRideService()..detail = _detail('en_route');
      final n = RideNotifier(svc, 'r-1');
      await n.load();
      expect(n.state.status, RideStatus.enRoute);
      expect(n.state.originLat, 26.14);
      expect(n.state.destLat, 26.18);
      expect(n.state.loaded, isTrue);
    });

    test('advance posts the event and applies the new status', () async {
      final svc = _FakeRideService()..advanceResult = 'arrived';
      final n = RideNotifier(svc, 'r-1');
      await n.advance('mark_arrived');
      expect(svc.advanceCalls.single, (rideId: 'r-1', event: 'mark_arrived'));
      expect(n.state.status, RideStatus.arrived);
      expect(n.state.busy, isFalse);
    });

    test('advance is ignored while a transition is already in flight', () async {
      final svc = _FakeRideService()..advanceResult = 'en_route';
      final n = RideNotifier(svc, 'r-1');
      final f1 = n.advance('start_en_route');
      final f2 = n.advance('start_en_route'); // busy → early return
      await Future.wait([f1, f2]);
      expect(svc.advanceCalls.length, 1);
    });

    test('advance error re-syncs from the server', () async {
      final svc = _FakeRideService()
        ..advanceError = Exception('409 conflict')
        ..detail = _detail('arrived'); // server truth
      final n = RideNotifier(svc, 'r-1');
      await n.advance('start_ride');
      expect(svc.getCalls, 1); // reloaded
      expect(n.state.status, RideStatus.arrived);
      expect(n.state.busy, isFalse);
    });

    test('load failure still flips loaded and leaves status unknown', () async {
      final svc = _FakeRideService()..getError = Exception('network');
      final n = RideNotifier(svc, 'r-1');
      await n.load();
      expect(n.state.loaded, isTrue);
      expect(n.state.status, RideStatus.unknown);
    });
  });
}
