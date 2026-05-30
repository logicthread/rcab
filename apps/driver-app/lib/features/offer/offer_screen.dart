import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'offer_models.dart';
import 'offer_provider.dart';

/// Ringing solo-ride offer. State + navigation are owned by `OfferController`;
/// this screen is presentational — it renders the live [offerProvider] state
/// and forwards Accept / Decline taps to the notifier. The `offerId` route
/// param is retained for deep-link symmetry but the body is driven by state.
class OfferScreen extends ConsumerStatefulWidget {
  const OfferScreen({super.key, required this.offerId});

  final String offerId;

  @override
  ConsumerState<OfferScreen> createState() => _OfferScreenState();
}

class _OfferScreenState extends ConsumerState<OfferScreen> {
  @override
  void initState() {
    super.initState();
    // 12 s TTL is short — alert hard on arrival (driver-screens UX rule).
    if (ref.read(offerProvider).phase == OfferPhase.ringing) {
      HapticFeedback.heavyImpact();
      SystemSound.play(SystemSoundType.alert);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(offerProvider);
    final offer = state.offer;
    return Scaffold(
      key: const Key('offer_screen'),
      body: SafeArea(
        child: offer == null
            ? const Center(child: Text('Waiting for an offer…'))
            : _OfferBody(state: state, offer: offer),
      ),
    );
  }
}

class _OfferBody extends ConsumerWidget {
  const _OfferBody({required this.state, required this.offer});

  final OfferState state;
  final SoloRideOffer offer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(offerProvider.notifier);
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 8),
          Text('New ride request', style: theme.textTheme.headlineSmall),
          const SizedBox(height: 4),
          Text(
            'Wave ${offer.waveNumber}',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 24),
          Text(
            '${state.secondsLeft}s',
            key: const Key('offer_countdown'),
            style: theme.textTheme.displaySmall,
          ),
          const SizedBox(height: 24),
          _row(context, Icons.my_location, 'Pickup',
              '${offer.pickupLat.toStringAsFixed(4)}, ${offer.pickupLng.toStringAsFixed(4)}'),
          const SizedBox(height: 12),
          _row(context, Icons.location_on, 'Dropoff',
              '${offer.dropoffLat.toStringAsFixed(4)}, ${offer.dropoffLng.toStringAsFixed(4)}'),
          const SizedBox(height: 24),
          Text(
            offer.fareDisplay,
            key: const Key('offer_fare'),
            style: theme.textTheme.headlineMedium,
          ),
          const Spacer(),
          if (state.isClaiming)
            const Center(
              key: Key('offer_claiming'),
              child: Padding(
                padding: EdgeInsets.all(16),
                child: CircularProgressIndicator(),
              ),
            )
          else if (state.isRinging)
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    key: const Key('offer_decline_button'),
                    onPressed: notifier.decline,
                    child: const Padding(
                      padding: EdgeInsets.symmetric(vertical: 14),
                      child: Text('Decline'),
                    ),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: FilledButton(
                    key: const Key('offer_accept_button'),
                    onPressed: notifier.accept,
                    child: const Padding(
                      padding: EdgeInsets.symmetric(vertical: 14),
                      child: Text('Accept'),
                    ),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, IconData icon, String label, String value) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(icon, size: 20),
        const SizedBox(width: 12),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: theme.textTheme.labelMedium),
            Text(value, style: theme.textTheme.bodyLarge),
          ],
        ),
      ],
    );
  }
}
