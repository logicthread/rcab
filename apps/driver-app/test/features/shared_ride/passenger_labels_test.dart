import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/features/shared_ride/shared_ride_models.dart';

SharedRideStop _s(int i, String pid, StopType t) =>
    SharedRideStop(sequenceIndex: i, passengerId: pid, type: t, lat: 26.18, lng: 91.81);

void main() {
  // Regression (RCAB-E8.S14): the stop list and the confirm button showed the
  // raw passenger UUID ("Picked up passenger 0000…-7100…").
  test('numbers passengers by first appearance in the itinerary', () {
    final labels = passengerLabels([
      _s(0, 'uuid-b', StopType.pickup),
      _s(1, 'uuid-a', StopType.pickup),
      _s(2, 'uuid-b', StopType.dropoff),
      _s(3, 'uuid-a', StopType.dropoff),
    ]);
    expect(labels, {'uuid-b': 'Passenger 1', 'uuid-a': 'Passenger 2'});
  });
}
