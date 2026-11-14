import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/core/api/api_error.dart';

DioException _err(Object? data, {int status = 400}) {
  final req = RequestOptions(path: '/v1/x');
  return DioException(
    requestOptions: req,
    response: data == null ? null : Response(requestOptions: req, statusCode: status, data: data),
    type: data == null ? DioExceptionType.connectionError : DioExceptionType.badResponse,
  );
}

void main() {
  test('reads the API envelope {error: {code, message, request_id}}', () {
    final e = ApiError.of(_err({
      'error': {'code': 'no_vehicle_selected', 'message': 'Please select a vehicle', 'request_id': 'r-1'},
    }))!;
    expect(e.code, 'no_vehicle_selected');
    expect(e.message, 'Please select a vehicle');
    expect(e.requestId, 'r-1');
  });

  test('tolerates a flat {code, message} body', () {
    final e = ApiError.of(_err({'code': 'vehicle_reg_exists', 'message': 'dup'}))!;
    expect(e.code, 'vehicle_reg_exists');
    expect(e.message, 'dup');
  });

  test('null without a JSON body (network error)', () {
    expect(ApiError.of(_err(null)), isNull);
    expect(ApiError.of(_err('<html>bad gateway</html>', status: 502)), isNull);
  });
}
