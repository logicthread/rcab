import 'package:dio/dio.dart';

/// The API's error body (AppExceptionFilter):
/// `{"error": {"code": "...", "message": "...", "request_id": "..."}}`.
///
/// Before RCAB-E8.S14 the app read `code` / `message` at the top level of the
/// body, which the real API never sends: `vehicle_reg_exists` and
/// `no_vehicle_selected` were never recognised and drivers saw Dio's internal
/// "This exception was thrown because…" text instead.
class ApiError {
  const ApiError({this.code, this.message, this.requestId});

  /// The envelope from a failed call, or null when there is no JSON body
  /// (network error, timeout, non-JSON response).
  static ApiError? of(DioException e) {
    final data = e.response?.data;
    if (data is! Map) return null;
    final inner = data['error'];
    final body = inner is Map ? inner : data;
    String? str(Object? v) => v is String && v.isNotEmpty ? v : null;
    return ApiError(
      code: str(body['code']),
      message: str(body['message']),
      requestId: str(body['request_id']),
    );
  }

  final String? code;
  final String? message;
  final String? requestId;
}
