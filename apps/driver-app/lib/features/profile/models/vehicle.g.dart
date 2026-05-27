// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'vehicle.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_$VehicleImpl _$$VehicleImplFromJson(Map<String, dynamic> json) =>
    _$VehicleImpl(
      id: json['id'] as String,
      driverId: json['driver_id'] as String,
      type: json['type'] as String,
      regNo: json['reg_no'] as String,
      make: json['make'] as String?,
      model: json['model'] as String?,
      color: json['color'] as String?,
      seats: (json['seats'] as num).toInt(),
      active: json['active'] as bool,
      createdAt: json['created_at'] as String,
    );

Map<String, dynamic> _$$VehicleImplToJson(_$VehicleImpl instance) =>
    <String, dynamic>{
      'id': instance.id,
      'driver_id': instance.driverId,
      'type': instance.type,
      'reg_no': instance.regNo,
      'make': instance.make,
      'model': instance.model,
      'color': instance.color,
      'seats': instance.seats,
      'active': instance.active,
      'created_at': instance.createdAt,
    };
