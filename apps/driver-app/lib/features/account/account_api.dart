import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../di/providers.dart';

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "7:05 PM"
String formatClock(DateTime t) {
  final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
  final m = t.minute.toString().padLeft(2, '0');
  return '$h:$m ${t.hour < 12 ? 'AM' : 'PM'}';
}

/// "18 Nov, 7:05 PM"
String formatWhen(DateTime t) => '${t.day} ${_months[t.month - 1]}, ${formatClock(t)}';

/// "₹185.00"
String formatRupees(int cents) => '₹${(cents / 100).toStringAsFixed(2)}';

/// One trip in the driver's history (GET /v1/rides).
class TripSummary {
  const TripSummary({
    required this.rideId,
    required this.status,
    required this.fareCents,
    required this.when,
    required this.scheduled,
  });

  final String rideId;
  final String status;
  final int fareCents;
  final DateTime when;
  final bool scheduled;

  factory TripSummary.fromJson(Map<String, dynamic> j) {
    final scheduledFor = j['scheduledFor'] as String?;
    return TripSummary(
      rideId: j['rideId'] as String,
      status: j['status'] as String,
      fareCents: ((j['fare'] as Map<String, dynamic>)['amount'] as num).toInt(),
      when: DateTime.parse(scheduledFor ?? j['createdAt'] as String).toLocal(),
      scheduled: scheduledFor != null,
    );
  }
}

class SupportMessage {
  const SupportMessage({
    required this.id,
    required this.fromSupport,
    required this.body,
    required this.createdAt,
  });

  final String id;
  final bool fromSupport;
  final String body;
  final DateTime createdAt;

  factory SupportMessage.fromJson(Map<String, dynamic> j) => SupportMessage(
        id: j['id'] as String,
        fromSupport: j['sender'] == 'support',
        body: j['body'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String).toLocal(),
      );
}

class DriverProfile {
  const DriverProfile({
    required this.displayName,
    required this.email,
    required this.phone,
    required this.ratingAvg,
    required this.ratingCount,
    required this.totalRides,
  });

  final String? displayName;
  final String? email;
  final String? phone;
  final double? ratingAvg;
  final int ratingCount;
  final int totalRides;

  factory DriverProfile.fromJson(Map<String, dynamic> j) {
    final d = j['driver'] as Map<String, dynamic>?;
    return DriverProfile(
      displayName: j['displayName'] as String?,
      email: j['email'] as String?,
      phone: j['phone'] as String?,
      ratingAvg: (d?['ratingAvg'] as num?)?.toDouble(),
      ratingCount: (d?['ratingCount'] as num?)?.toInt() ?? 0,
      totalRides: (d?['totalRides'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Newest first.
final tripHistoryProvider = FutureProvider.autoDispose<List<TripSummary>>((ref) async {
  final res = await ref
      .read(apiClientProvider)
      .get<Map<String, dynamic>>('/v1/rides', queryParameters: {'limit': 30});
  final rides = (res.data?['rides'] as List<dynamic>? ?? []);
  return rides.map((e) => TripSummary.fromJson(e as Map<String, dynamic>)).toList();
});

final driverProfileProvider = FutureProvider.autoDispose<DriverProfile>((ref) async {
  final res = await ref.read(apiClientProvider).get<Map<String, dynamic>>('/v1/me');
  return DriverProfile.fromJson(res.data!);
});

/// Thin wrapper over the account endpoints (feedback, support chat, profile name).
class AccountApi {
  AccountApi(this._ref);
  final Ref _ref;

  Future<void> sendFeedback(String category, String message) async {
    await _ref
        .read(apiClientProvider)
        .post<dynamic>('/v1/feedback', data: {'category': category, 'message': message});
  }

  Future<List<SupportMessage>> supportMessages() async {
    final res = await _ref.read(apiClientProvider).get<Map<String, dynamic>>('/v1/support/messages');
    return _parse(res.data);
  }

  /// Returns the messages this send created (the driver's, plus an acknowledgement on the first).
  Future<List<SupportMessage>> sendSupport(String body) async {
    final res = await _ref
        .read(apiClientProvider)
        .post<Map<String, dynamic>>('/v1/support/messages', data: {'body': body});
    return _parse(res.data);
  }

  Future<void> updateName(String name) async {
    await _ref.read(apiClientProvider).patch<dynamic>('/v1/me', data: {'displayName': name});
  }

  List<SupportMessage> _parse(Map<String, dynamic>? data) =>
      (data?['messages'] as List<dynamic>? ?? [])
          .map((e) => SupportMessage.fromJson(e as Map<String, dynamic>))
          .toList();
}

final accountApiProvider = Provider<AccountApi>((ref) => AccountApi(ref));
