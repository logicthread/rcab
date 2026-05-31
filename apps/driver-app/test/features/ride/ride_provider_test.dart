import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/features/ride/ride_models.dart';
import 'package:driver_app/features/ride/ride_provider.dart';

class _FakeRideService implements RideService {
  RideDetail? detail;
  String? advanceResult;
  String? cancelResult;
  String? noShowResult;
  Object? getError;
  Object? advanceError;
  Object? cancelError;
  Object? noShowError;
  int getCalls = 0;
  final List<({String rideId, String event})> advanceCalls = [];
  final List<({String rideId, String? reason})> cancelCalls = [];
  int noShowCalls = 0;

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

  @override
  Future<String> cancel(String rideId, {String? reason}) async {
    cancelCalls.add((rideId: rideId, reason: reason));
    if (cancelError != null) throw cancelError!;
    return cancelResult!;
  }

  @override
  Future<String> reportNoShow(String rideId) async {
    noShowCalls++;
    if (noShowError != null) throw noShowError!;
    return noShowResult!;
  }
}

RideDetail _detail(String status, {DateTime? arrivedAt}) => RideDetail(
      rideId: 'r-1',
      status: status,
      originLat: 26.14,
      originLng: 91.73,
      destLat: 26.18,
      destLng: 91.75,
      arrivedAt: arrivedAt,
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
      expect(RideStatus.parse('no_show'), RideStatus.noShow);
      expect(RideStatus.parse('weird'), RideStatus.unknown);
      expect(RideStatus.parse(null), RideStatus.unknown);
    });

    test('cancelled / no_show are terminal; live states are driver-cancellable', () {
      expect(RideStatus.cancelled.isTerminal, isTrue);
      expect(RideStatus.noShow.isTerminal, isTrue);
      expect(RideStatus.arrived.canDriverCancel, isTrue);
      expect(RideStatus.inProgress.canDriverCancel, isTrue);
      expect(RideStatus.completed.canDriverCancel, isFalse);
      expect(RideStatus.requested.canDriverCancel, isFalse);
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

    test('noShowReady true only when arrived and the 5-min wait has elapsed', () {
      final arrivedAt = DateTime.utc(2026, 5, 31, 10, 0, 0);
      final s = RideState(rideId: 'r-1', status: RideStatus.arrived, arrivedAt: arrivedAt);
      expect(s.noShowReady(now: DateTime.utc(2026, 5, 31, 10, 4, 59)), isFalse);
      expect(s.noShowReady(now: DateTime.utc(2026, 5, 31, 10, 5, 0)), isTrue);
      // Wrong state, or no arrival timestamp → never ready.
      expect(
        s.copyWith(status: RideStatus.enRoute).noShowReady(now: DateTime.utc(2026, 5, 31, 11)),
        isFalse,
      );
      const noStamp = RideState(rideId: 'r-1', status: RideStatus.arrived);
      expect(noStamp.noShowReady(now: DateTime.utc(2026, 5, 31, 11)), isFalse);
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

    test('load hydrates arrivedAt for the no-show gate', () async {
      final arrivedAt = DateTime.utc(2026, 5, 31, 10);
      final svc = _FakeRideService()..detail = _detail('arrived', arrivedAt: arrivedAt);
      final n = RideNotifier(svc, 'r-1');
      await n.load();
      expect(n.state.arrivedAt, arrivedAt);
    });

    test('cancel posts the reason and applies the new status', () async {
      final svc = _FakeRideService()..cancelResult = 'cancelled';
      final n = RideNotifier(svc, 'r-1');
      await n.cancel('Vehicle issue');
      expect(svc.cancelCalls.single, (rideId: 'r-1', reason: 'Vehicle issue'));
      expect(n.state.status, RideStatus.cancelled);
      expect(n.state.busy, isFalse);
    });

    test('reportNoShow applies the no_show status', () async {
      final svc = _FakeRideService()..noShowResult = 'no_show';
      final n = RideNotifier(svc, 'r-1');
      await n.reportNoShow();
      expect(svc.noShowCalls, 1);
      expect(n.state.status, RideStatus.noShow);
    });

    test('reportNoShow error (too early) re-syncs and stays arrived', () async {
      final svc = _FakeRideService()
        ..noShowError = Exception('409 no_show_too_early')
        ..detail = _detail('arrived');
      final n = RideNotifier(svc, 'r-1');
      await n.reportNoShow();
      expect(svc.getCalls, 1); // reloaded
      expect(n.state.status, RideStatus.arrived);
      expect(n.state.busy, isFalse);
    });
  });
}
