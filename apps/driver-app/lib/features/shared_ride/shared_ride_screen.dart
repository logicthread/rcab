import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../home/driver_notice.dart';
import 'shared_ride_models.dart';
import 'shared_ride_provider.dart';
import 'stop_list_tile.dart';

class SharedRideScreen extends ConsumerStatefulWidget {
  const SharedRideScreen({super.key, required this.rideId});

  final String rideId;

  @override
  ConsumerState<SharedRideScreen> createState() => _SharedRideScreenState();
}

class _SharedRideScreenState extends ConsumerState<SharedRideScreen> {
  bool _routedHome = false;

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(sharedRideProvider);

    // When the last drop-off completes the pool, return home with a summary.
    // There is deliberately no rating prompt here: a shared pool is not a
    // `rides` row, so `POST /v1/rides/<poolId>/ratings` is always 404 and the
    // prompt this used to open could never be submitted (RCAB-E8.S14).
    // Per-passenger shared-ride rating is a product gap (Epic E7).
    ref.listen<SharedRideState>(sharedRideProvider, (prev, next) {
      if (!_routedHome && next.completed && next.sharedRideId == widget.rideId) {
        _routedHome = true;
        final riders = passengerLabels(next.stops.map((s) => s.stop)).length;
        ref.read(driverNoticeProvider.notifier).state =
            'Shared ride complete · $riders passenger${riders == 1 ? '' : 's'} dropped off';
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          context.go('/home');
        });
      }
    });

    if (state.sharedRideId != widget.rideId || state.phase == SharedRidePhase.none) {
      return const Scaffold(
        body: Center(
          child: Text(
            'No active shared ride',
            key: Key('shared_ride_empty'),
          ),
        ),
      );
    }

    // An offer is not an assignment (F10): show the proposed itinerary with
    // Accept / Decline; the stop controls only exist once the server commits.
    if (state.isOffer) return _SharedOfferView(state: state);
    if (state.isTerminalOutcome) return _OutcomeView(state: state);

    final current = state.currentStop;
    final canConfirm = !state.completed && current?.status == StopStatus.pending;
    final labels = passengerLabels(state.stops.map((s) => s.stop));
    final who = current == null ? '' : labels[current.stop.passengerId]!;
    final buttonLabel = current == null
        ? 'Ride complete'
        : current.stop.type == StopType.pickup
            ? 'Picked up $who'
            : 'Dropped off $who';

    return Scaffold(
      appBar: AppBar(
        title: const Text('Shared ride'),
        key: const Key('shared_ride_appbar'),
      ),
      body: Column(
        key: const Key('shared_ride_screen'),
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              'Ride ${widget.rideId} · ${state.stops.length} stops',
              style: Theme.of(context).textTheme.titleSmall,
            ),
          ),
          Expanded(
            child: ListView.separated(
              key: const Key('shared_ride_stop_list'),
              itemCount: state.stops.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) {
                return StopListTile(
                  stopState: state.stops[i],
                  isCurrent: i == state.currentStopIndex,
                  passengerLabel: labels[state.stops[i].stop.passengerId],
                );
              },
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: SizedBox(
                width: double.infinity,
                child: FilledButton(
                  key: const Key('shared_ride_confirm_button'),
                  onPressed: canConfirm
                      ? () {
                          ref
                              .read(sharedRideProvider.notifier)
                              .confirmCurrentStop();
                        }
                      : null,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(
                      buttonLabel,
                      style: const TextStyle(fontSize: 16),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SharedOfferView extends ConsumerWidget {
  const _SharedOfferView({required this.state});

  final SharedRideState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final notifier = ref.read(sharedRideProvider.notifier);
    final theme = Theme.of(context);
    final accepting = state.phase == SharedRidePhase.accepting;
    return Scaffold(
      key: const Key('shared_offer_screen'),
      appBar: AppBar(title: const Text('Shared ride offer')),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${state.passengerCount} ${state.passengerCount == 1 ? 'passenger' : 'passengers'} · ${state.stops.length} stops',
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                Text(
                  '${state.secondsLeft}s',
                  key: const Key('shared_offer_countdown'),
                  style: theme.textTheme.displaySmall,
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView.separated(
              key: const Key('shared_offer_itinerary'),
              itemCount: state.stops.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (_, i) => StopListTile(
                stopState: state.stops[i],
                isCurrent: false,
                passengerLabel: passengerLabels(state.stops.map((s) => s.stop))[state.stops[i].stop.passengerId],
              ),
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: accepting
                  ? const Center(
                      key: Key('shared_offer_claiming'),
                      child: Padding(
                        padding: EdgeInsets.all(16),
                        child: CircularProgressIndicator(),
                      ),
                    )
                  : Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            key: const Key('shared_offer_decline_button'),
                            onPressed: () {
                              notifier.decline();
                              GoRouter.maybeOf(context)?.go('/home');
                            },
                            child: const Padding(
                              padding: EdgeInsets.symmetric(vertical: 14),
                              child: Text('Decline'),
                            ),
                          ),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: FilledButton(
                            key: const Key('shared_offer_accept_button'),
                            onPressed: () => notifier.accept(),
                            child: const Padding(
                              padding: EdgeInsets.symmetric(vertical: 14),
                              child: Text('Accept'),
                            ),
                          ),
                        ),
                      ],
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

class _OutcomeView extends StatelessWidget {
  const _OutcomeView({required this.state});

  final SharedRideState state;

  @override
  Widget build(BuildContext context) {
    final message = switch (state.phase) {
      SharedRidePhase.lost => 'Another driver took this ride',
      SharedRidePhase.expired => 'This offer expired',
      SharedRidePhase.revoked => 'This ride is no longer available',
      _ => 'Could not accept this ride',
    };
    return Scaffold(
      body: Center(child: Text(message, key: const Key('shared_offer_outcome'))),
    );
  }
}
