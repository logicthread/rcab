import 'package:freezed_annotation/freezed_annotation.dart';

part 'vehicle.freezed.dart';
part 'vehicle.g.dart';

/// A driver's vehicle as returned by `GET /v1/vehicles`.
///
/// The API answers in camelCase (the Drizzle row: `driverId`, `regNo`,
/// `createdAt`) even though `POST /v1/vehicles` takes snake_case input
/// (`reg_no`). Parsing snake_case here made the profile screen fail with
/// "Failed to load vehicles" against the real API (RCAB-E8.S14).
@freezed
class Vehicle with _$Vehicle {
  const factory Vehicle({
    required String id,
    required String driverId,
    required String type,
    required String regNo,
    required String? make,
    required String? model,
    required String? color,
    required int seats,
    required bool active,
    required String createdAt,
    /// The server's current vehicle (`driver.current_vehicle_id`), the one used
    /// when going online. Older APIs omit it.
    @Default(false) bool isCurrent,
  }) = _Vehicle;

  factory Vehicle.fromJson(Map<String, dynamic> json) => _$VehicleFromJson(json);
}

/// Rider/driver-facing name of a vehicle type (the API value is an enum).
String vehicleTypeLabel(String type) => switch (type) {
      'auto' => 'Auto-rickshaw',
      'bike' => 'Bike',
      'cab_hatch' => 'Hatchback cab',
      'cab_sedan' => 'Sedan cab',
      _ => type,
    };
