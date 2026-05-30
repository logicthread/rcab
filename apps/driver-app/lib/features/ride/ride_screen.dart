import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'ride_models.dart';
import 'ride_provider.dart';

/// Active solo ride. Driven by [rideProvider]: a single status-appropriate
/// action button advances the [[sm-ride-lifecycle]] forward state machine via
/// `POST /v1/rides/:id/state`, a prominent Navigate button opens Google Maps to
/// the current target, and the screen routes on to `/rating/:id` when the ride
/// completes. RCAB-E4.S6.
class RideScreen extends ConsumerStatefulWidget {
  const RideScreen({super.key, required this.rideId});

  final String rideId;

  @override
  ConsumerState<RideScreen> createState() => _RideScreenState();
}

class _RideScreenState extends ConsumerState<RideScreen> {
  bool _navigatedToRating = false;

  @override
  void initState() {
    super.initState();
    // Hydrate current state on mount (also covers reconnect-restore).
    Future.microtask(() {
      if (mounted) ref.read(rideProvider(widget.rideId).notifier).load();
    });
  }

  Future<void> _openMaps(RideState state) async {
    final lat = state.navLat;
    final lng = state.navLng;
    if (lat == null || lng == null) return;
    // Android geo-intent for turn-by-turn (driver-app is Android-only Phase-0).
    await ref.read(mapsLauncherProvider)(Uri.parse('google.navigation:q=$lat,$lng&mode=d'));
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(rideProvider(widget.rideId));
    final theme = Theme.of(context);

    // Route on to the rating prompt once the ride completes.
    ref.listen<RideState>(rideProvider(widget.rideId), (prev, next) {
      if (!_navigatedToRating && next.status == RideStatus.completed) {
        _navigatedToRating = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          context.go('/rating/${widget.rideId}');
        });
      }
    });

    final actionLabel = state.status.actionLabel;
    final nextEvent = state.status.nextEvent;

    return Scaffold(
      key: const Key('ride_screen'),
      appBar: AppBar(title: const Text('Active ride')),
      body: SafeArea(
        child: !state.loaded
            ? const Center(child: CircularProgressIndicator(key: Key('ride_loading')))
            : Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text('Ride ${widget.rideId}', style: theme.textTheme.bodySmall),
                    const SizedBox(height: 8),
                    Text(
                      _statusHeadline(state.status),
                      key: const Key('ride_status'),
                      style: theme.textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 24),
                    // Navigate is the most prominent control on the ride screen.
                    SizedBox(
                      height: 64,
                      child: FilledButton.icon(
                        key: const Key('ride_navigate_button'),
                        onPressed: state.hasCoords ? () => _openMaps(state) : null,
                        icon: const Icon(Icons.navigation),
                        label: Text(
                          state.status.isHeadingToDropoff
                              ? 'Navigate to dropoff'
                              : 'Navigate to pickup',
                          style: const TextStyle(fontSize: 18),
                        ),
                      ),
                    ),
                    const Spacer(),
                    if (state.busy)
                      const Center(
                        key: Key('ride_busy'),
                        child: Padding(
                          padding: EdgeInsets.all(16),
                          child: CircularProgressIndicator(),
                        ),
                      )
                    else if (actionLabel != null && nextEvent != null)
                      SizedBox(
                        height: 56,
                        child: FilledButton(
                          key: const Key('ride_action_button'),
                          onPressed: () =>
                              ref.read(rideProvider(widget.rideId).notifier).advance(nextEvent),
                          child: Text(actionLabel, style: const TextStyle(fontSize: 18)),
                        ),
                      ),
                  ],
                ),
              ),
      ),
    );
  }

  String _statusHeadline(RideStatus s) => switch (s) {
        RideStatus.accepted => 'Heading to pickup',
        RideStatus.enRoute => 'En route to pickup',
        RideStatus.arrived => 'Arrived at pickup',
        RideStatus.inProgress => 'Trip in progress',
        RideStatus.completed => 'Ride complete',
        _ => 'Active ride',
      };
}
