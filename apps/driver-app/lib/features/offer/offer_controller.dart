import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../di/providers.dart';
import 'offer_models.dart';
import 'offer_provider.dart';

typedef NavigateFn = void Function(String location);

/// Bridges the realtime socket to the solo-offer [offerProvider] and owns all
/// offer navigation: auto-opens `/offer/:id` on an incoming solo `ride_offer`,
/// routes to `/ride/:id` when the driver wins (`ride_offer_accepted`), and
/// returns to `/home` on revoke or TTL expiry. Mirrors `SharedRideController`;
/// shared offers (those carrying a `stops` array) are ignored here.
class OfferController {
  OfferController({
    required this.container,
    GoRouter? router,
    NavigateFn? navigate,
    this.tickInterval = const Duration(seconds: 1),
  })  : _navigate = navigate ?? ((loc) => router?.go(loc)),
        assert(router != null || navigate != null,
            'Provide either router or navigate callback');

  final ProviderContainer container;
  final NavigateFn _navigate;

  /// Countdown granularity. Injectable so tests can drive expiry without
  /// waiting a real 12 seconds.
  final Duration tickInterval;

  final List<StreamSubscription<dynamic>> _subs = [];
  Timer? _ticker;

  Future<void> start() async {
    final socket = container.read(realtimeSocketProvider);
    await socket.connect();
    _subs.add(socket.rideOffer.listen(_onRideOffer));
    _subs.add(socket.rideOfferAccepted.listen(_onAccepted));
    _subs.add(socket.rideOfferRevoked.listen(_onRevoked));
  }

  void stop() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    _subs.clear();
    _cancelTicker();
  }

  OfferNotifier get _notifier => container.read(offerProvider.notifier);

  void _onRideOffer(Map<String, dynamic> payload) {
    final offer = SoloRideOffer.tryFromRideOfferJson(payload);
    if (offer == null) return; // shared offer — SharedRideController handles it
    _notifier.applyOffer(offer);
    _navigate('/offer/${offer.offerId}');
    _startTicker();
  }

  void _onAccepted(Map<String, dynamic> payload) {
    final offerId = payload['offerId'] as String?;
    final rideId = payload['rideId'] as String?;
    if (offerId == null || rideId == null) return;
    if (_notifier.applyAccepted(offerId: offerId, rideId: rideId)) {
      _cancelTicker();
      _navigate('/ride/$rideId');
    }
  }

  void _onRevoked(Map<String, dynamic> payload) {
    final offerId = payload['offerId'] as String?;
    if (offerId == null) return;
    if (_notifier.applyRevoked(
      offerId: offerId,
      reason: payload['reason'] as String?,
    )) {
      _cancelTicker();
      _navigate('/home');
    }
  }

  void _startTicker() {
    _cancelTicker();
    _ticker = Timer.periodic(tickInterval, (_) {
      _notifier.tick();
      if (container.read(offerProvider).phase == OfferPhase.expired) {
        _cancelTicker();
        _navigate('/home');
      }
    });
  }

  void _cancelTicker() {
    _ticker?.cancel();
    _ticker = null;
  }
}

final offerControllerProvider = Provider<OfferController>((ref) {
  throw UnimplementedError(
    'Provide a router when overriding offerControllerProvider.',
  );
});
