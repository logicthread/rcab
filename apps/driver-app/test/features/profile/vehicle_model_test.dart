import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/features/profile/models/vehicle.dart';

void main() {
  // Regression (RCAB-E8.S14): GET /v1/vehicles answers with the Drizzle row in
  // camelCase. The model used to read snake_case keys, so every real response
  // threw and the profile screen showed "Failed to load vehicles".
  test('parses the camelCase GET /v1/vehicles row the API actually returns', () {
    final v = Vehicle.fromJson(const {
      'id': '00000000-0000-4000-8000-000000720001',
      'driverId': '00000000-0000-4000-8000-000000700001',
      'type': 'cab_sedan',
      'regNo': 'AS01DB0001',
      'make': 'Maruti',
      'model': 'Dzire',
      'color': 'white',
      'seats': 4,
      'active': true,
      'createdAt': '2026-11-09T14:28:23.579Z',
    });
    expect(v.regNo, 'AS01DB0001');
    expect(v.driverId, '00000000-0000-4000-8000-000000700001');
    expect(v.createdAt, '2026-11-09T14:28:23.579Z');
    expect(v.seats, 4);
  });
}
