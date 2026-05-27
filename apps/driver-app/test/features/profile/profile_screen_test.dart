import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/profile/models/vehicle.dart';
import 'package:driver_app/features/profile/profile_screen.dart';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockDio extends Mock implements Dio {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _sampleVehicle = Vehicle(
  id: 'v1',
  driverId: 'd1',
  type: 'cab_sedan',
  regNo: 'KA-01-AB-1234',
  make: 'Toyota',
  model: 'Camry',
  color: 'White',
  seats: 4,
  active: true,
  createdAt: '2024-01-01T00:00:00Z',
);

Widget _buildScreen({
  required List<Vehicle> vehicles,
  MockDio? mockDio,
}) {
  final dio = mockDio ?? MockDio();
  return ProviderScope(
    overrides: [
      vehiclesProvider.overrideWith((_) => Future.value(vehicles)),
      apiClientProvider.overrideWithValue(dio),
    ],
    child: const MaterialApp(home: ProfileScreen()),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  setUpAll(() {
    registerFallbackValue(RequestOptions(path: ''));
  });

  testWidgets('empty state renders with Add vehicle button', (tester) async {
    await tester.pumpWidget(_buildScreen(vehicles: []));
    await tester.pump();

    expect(find.byKey(const Key('empty_state_label')), findsOneWidget);
    expect(find.byKey(const Key('add_vehicle_button')), findsOneWidget);
    expect(find.byKey(const Key('vehicle_list')), findsNothing);
  });

  testWidgets('vehicle row appears when vehicles are returned', (tester) async {
    await tester.pumpWidget(_buildScreen(vehicles: [_sampleVehicle]));
    await tester.pump();

    expect(find.byKey(const Key('vehicle_list')), findsOneWidget);
    expect(find.byKey(const Key('vehicle_row_v1')), findsOneWidget);
    expect(find.text('cab_sedan · KA-01-AB-1234'), findsOneWidget);
    expect(find.byKey(const Key('empty_state_label')), findsNothing);
  });

  testWidgets('Select button calls PATCH /v1/drivers/me/vehicle', (tester) async {
    final mockDio = MockDio();
    when(() => mockDio.patch(
          any(),
          data: any(named: 'data'),
          options: any(named: 'options'),
          cancelToken: any(named: 'cancelToken'),
          onReceiveProgress: any(named: 'onReceiveProgress'),
        )).thenAnswer((_) async => Response(
          data: {'current_vehicle_id': 'v1'},
          requestOptions: RequestOptions(path: '/v1/drivers/me/vehicle'),
          statusCode: 200,
        ));

    await tester.pumpWidget(_buildScreen(vehicles: [_sampleVehicle], mockDio: mockDio));
    await tester.pump();

    await tester.tap(find.byKey(const Key('select_vehicle_v1')));
    await tester.pump();

    verify(() => mockDio.patch(
          '/v1/drivers/me/vehicle',
          data: {'vehicle_id': 'v1'},
          options: any(named: 'options'),
          cancelToken: any(named: 'cancelToken'),
          onReceiveProgress: any(named: 'onReceiveProgress'),
        )).called(1);
  });
}
