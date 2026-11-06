import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/core/realtime/driver_assignment.dart';
import 'package:driver_app/core/realtime/offer_outcome.dart';

void main() {
  group('OfferOutcome.jsonFromAck (ride_offer_response ack → outcome)', () {
    test('a committed shared accept → assigned with trip + generation', () {
      final json = OfferOutcome.jsonFromAck(
        offerId: 'o-1',
        accept: true,
        ack: {
          'ok': true,
          'trip': {'kind': 'shared', 'sharedRideId': 'p-1'},
          'generation': 2,
          'replay': false,
        },
      )!;
      final o = OfferOutcome.fromJson(json)!;
      expect(o.kind, OfferOutcomeKind.assigned);
      expect(o.tripKind, 'shared');
      expect(o.tripId, 'p-1');
      expect(o.generation, 2);
    });

    test('a committed solo accept names the ride', () {
      final o = OfferOutcome.fromJson(OfferOutcome.jsonFromAck(
        offerId: 'o-1',
        accept: true,
        ack: {'ok': true, 'trip': {'kind': 'solo', 'rideId': 'r-1'}, 'generation': 1},
      )!)!;
      expect(o.tripId, 'r-1');
      expect(o.isShared, isFalse);
    });

    final cases = <String, OfferOutcomeKind>{
      'trip_taken': OfferOutcomeKind.lost,
      'offer_expired': OfferOutcomeKind.expired,
      'offer_stale': OfferOutcomeKind.expired,
      'offer_revoked': OfferOutcomeKind.revoked,
      'trip_not_claimable': OfferOutcomeKind.revoked,
      'conflict': OfferOutcomeKind.retry,
      // Server could not decide: NOT a terminal loss (accept may have committed).
      'unavailable': OfferOutcomeKind.unknown,
      'driver_busy': OfferOutcomeKind.rejected,
      'itinerary_missing': OfferOutcomeKind.rejected,
      'invalid_payload': OfferOutcomeKind.rejected,
    };
    cases.forEach((reason, kind) {
      test('refusal $reason → ${kind.name}', () {
        final o = OfferOutcome.fromJson(OfferOutcome.jsonFromAck(
          offerId: 'o-1',
          accept: true,
          ack: {'ok': false, 'reason': reason},
        )!)!;
        expect(o.kind, kind);
        expect(o.reason, reason);
      });
    });

    test('a decline ack is a declined outcome; a missing ack yields nothing', () {
      expect(
        OfferOutcome.fromJson(
          OfferOutcome.jsonFromAck(offerId: 'o', accept: false, ack: 'declined')!,
        )!.kind,
        OfferOutcomeKind.declined,
      );
      expect(OfferOutcome.jsonFromAck(offerId: 'o', accept: true, ack: null), isNull);
    });

    test('fromJson rejects unknown outcomes', () {
      expect(OfferOutcome.fromJson({'offerId': 'o', 'outcome': 'maybe'}), isNull);
      expect(OfferOutcome.fromJson({'outcome': 'lost'}), isNull);
    });
  });

  group('DriverAssignmentSnapshot.fromJson', () {
    test('null assignment = released; missing key = not a snapshot', () {
      expect(DriverAssignmentSnapshot.fromJson({'driverId': 'd', 'assignment': null})!.assignment, isNull);
      expect(DriverAssignmentSnapshot.fromJson({'ok': false}), isNull);
    });

    test('parses a shared assignment with its itinerary', () {
      final a = DriverAssignmentSnapshot.fromJson({
        'driverId': 'd',
        'assignment': {
          'tripKind': 'shared',
          'tripId': 'p-1',
          'offerId': 'o-1',
          'generation': 1,
          'version': 5,
          'poolStatus': 'closed_started',
          'stops': [
            {'sequenceIndex': 0, 'type': 'pickup', 'passengerId': 'pa', 'lat': 1, 'lng': 2, 'confirmed': true},
          ],
        },
      })!.assignment!;
      expect(a.isShared, isTrue);
      expect(a.version, 5);
      expect(a.stops.single['confirmed'], isTrue);
    });

    test('a malformed assignment is treated as absent', () {
      expect(DriverAssignment.fromJson({'tripKind': 'bus', 'tripId': 'x'}), isNull);
      expect(DriverAssignment.fromJson('nope'), isNull);
    });
  });
}
