import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/profile/models/vehicle.dart';
import 'package:driver_app/features/profile/vehicle_form_screen.dart';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockDio extends Mock implements Dio {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

Widget _buildScreen(MockDio mockDio) {
  return ProviderScope(
    overrides: [
      vehiclesProvider.overrideWith((_) => Future.value(const <Vehicle>[])),
      apiClientProvider.overrideWithValue(mockDio),
    ],
    child: const MaterialApp(home: VehicleFormScreen()),
  );
}

Future<void> _fillForm(WidgetTester tester, {String regNo = 'KA-01-AB-1234'}) async {
  // Select type
  await tester.tap(find.byKey(const Key('type_dropdown')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('cab_sedan').last);
  await tester.pumpAndSettle();

  await tester.enterText(find.byKey(const Key('reg_no_field')), regNo);
  await tester.enterText(find.byKey(const Key('make_field')), 'Toyota');
  await tester.enterText(find.byKey(const Key('model_field')), 'Camry');
  await tester.enterText(find.byKey(const Key('color_field')), 'White');
  await tester.enterText(find.byKey(const Key('seats_field')), '4');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  setUpAll(() {
    registerFallbackValue(RequestOptions(path: ''));
  });

  testWidgets('form fields are present', (tester) async {
    final mockDio = MockDio();
    await tester.pumpWidget(_buildScreen(mockDio));

    expect(find.byKey(const Key('type_dropdown')), findsOneWidget);
    expect(find.byKey(const Key('reg_no_field')), findsOneWidget);
    expect(find.byKey(const Key('make_field')), findsOneWidget);
    expect(find.byKey(const Key('model_field')), findsOneWidget);
    expect(find.byKey(const Key('color_field')), findsOneWidget);
    expect(find.byKey(const Key('seats_field')), findsOneWidget);
    expect(find.byKey(const Key('submit_button')), findsOneWidget);
  });

  testWidgets('blank reg_no shows inline validation error', (tester) async {
    final mockDio = MockDio();
    await tester.pumpWidget(_buildScreen(mockDio));

    // Submit without filling reg_no (leave it blank, fill rest minimally)
    await tester.tap(find.byKey(const Key('submit_button')));
    await tester.pump();

    expect(find.text('Registration number required'), findsOneWidget);
    verifyNever(() => mockDio.post(any(), data: any(named: 'data')));
  });

  testWidgets('submit calls POST /v1/vehicles with correct payload', (tester) async {
    final mockDio = MockDio();
    when(() => mockDio.post(
          any(),
          data: any(named: 'data'),
          options: any(named: 'options'),
          cancelToken: any(named: 'cancelToken'),
          onSendProgress: any(named: 'onSendProgress'),
          onReceiveProgress: any(named: 'onReceiveProgress'),
        )).thenAnswer((_) async => Response(
          data: {'id': 'v1', 'driver_id': 'd1', 'type': 'cab_sedan', 'reg_no': 'KA-01-AB-1234', 'make': 'Toyota', 'model': 'Camry', 'color': 'White', 'seats': 4, 'active': true, 'created_at': '2024-01-01T00:00:00Z'},
          requestOptions: RequestOptions(path: '/v1/vehicles'),
          statusCode: 201,
        ));

    await tester.pumpWidget(_buildScreen(mockDio));
    await _fillForm(tester);

    await tester.tap(find.byKey(const Key('submit_button')));
    await tester.pump();

    verify(() => mockDio.post(
          '/v1/vehicles',
          data: {
            'type': 'cab_sedan',
            'reg_no': 'KA-01-AB-1234',
            'make': 'Toyota',
            'model': 'Camry',
            'color': 'White',
            'seats': 4,
          },
          options: any(named: 'options'),
          cancelToken: any(named: 'cancelToken'),
          onSendProgress: any(named: 'onSendProgress'),
          onReceiveProgress: any(named: 'onReceiveProgress'),
        )).called(1);
  });

  testWidgets('409 vehicle_reg_exists shows snackbar', (tester) async {
    final mockDio = MockDio();
    when(() => mockDio.post(
          any(),
          data: any(named: 'data'),
          options: any(named: 'options'),
          cancelToken: any(named: 'cancelToken'),
          onSendProgress: any(named: 'onSendProgress'),
          onReceiveProgress: any(named: 'onReceiveProgress'),
        )).thenThrow(DioException(
          requestOptions: RequestOptions(path: '/v1/vehicles'),
          response: Response(
            data: {'code': 'vehicle_reg_exists'},
            requestOptions: RequestOptions(path: '/v1/vehicles'),
            statusCode: 409,
          ),
          type: DioExceptionType.badResponse,
        ));

    await tester.pumpWidget(_buildScreen(mockDio));
    await _fillForm(tester);

    await tester.tap(find.byKey(const Key('submit_button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(
      find.text('You already have a vehicle with that registration number.'),
      findsOneWidget,
    );
  });
}
