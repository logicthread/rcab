import 'package:freezed_annotation/freezed_annotation.dart';

part 'vehicle.freezed.dart';
part 'vehicle.g.dart';

@freezed
class Vehicle with _$Vehicle {
  const factory Vehicle({
    required String id,
    @JsonKey(name: 'driver_id') required String driverId,
    required String type,
    @JsonKey(name: 'reg_no') required String regNo,
    required String? make,
    required String? model,
    required String? color,
    required int seats,
    required bool active,
    @JsonKey(name: 'created_at') required String createdAt,
  }) = _Vehicle;

  factory Vehicle.fromJson(Map<String, dynamic> json) => _$VehicleFromJson(json);
}
