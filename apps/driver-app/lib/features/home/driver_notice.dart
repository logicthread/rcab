import 'package:flutter_riverpod/flutter_riverpod.dart';

/// One-shot message for the home screen after the app routes the driver back
/// there on its own (offer lost / expired / revoked, ride cancelled by the
/// passenger, …). Before RCAB-E8.S14 these screens just vanished with no
/// explanation. Home shows it once as a SnackBar and clears it.
final driverNoticeProvider = StateProvider<String?>((_) => null);

/// Driver-facing text for an offer that ended without an assignment.
/// [reason] is an outcome kind (`lost`, `expired`, …), a server accept-failure
/// reason (`trip_taken`, `offer_expired`, …) or a legacy revoke reason.
String offerEndedNotice(String? reason) {
  switch (reason) {
    case 'lost':
    case 'trip_taken':
    case 'taken':
      return 'Another driver accepted this ride';
    case 'expired':
    case 'offer_expired':
    case 'offer_stale':
      return 'The offer expired';
    case 'rejected':
    case 'busy':
    case 'driver_busy':
    case 'driver_ineligible':
    case 'vehicle_capacity':
      return 'You could not accept this ride';
    default:
      return 'This ride is no longer available';
  }
}
