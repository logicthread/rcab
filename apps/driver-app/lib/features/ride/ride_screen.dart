import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'ride_models.dart';
import 'ride_provider.dart';

/// Active solo ride. Driven by [rideProvider]: a single status-appropriate
/// action button advances the [[sm-ride-lifecycle]] forward state machine via
/// `POST /v1/rides/:id/state` (RCAB-E4.S6); a prominent Navigate button opens
/// Google Maps. The driver may also cancel (with a reason) or — once `arrived`
/// and the 5-minute wait elapses — report a no-show (RCAB-E4.S8). The screen
/// routes on to `/rating/:id` on completion and `/home` on a terminal cancel.
class RideScreen extends ConsumerStatefulWidget {
  const RideScreen({super.key, required this.rideId});

  final String rideId;

  @override
  ConsumerState<RideScreen> createState() => _RideScreenState();
}

class _RideScreenState extends ConsumerState<RideScreen> {
  static const _cancelReasons = ['Passenger not reachable', 'Vehicle issue', 'Other'];

  bool _routedAway = false;
  Timer? _noShowTimer;

  @override
  void initState() {
    super.initState();
    // Hydrate current state on mount (also covers reconnect-restore).
    Future.microtask(() {
      if (mounted) ref.read(rideProvider(widget.rideId).notifier).load();
    });
  }

  @override
  void dispose() {
    _noShowTimer?.cancel();
    super.dispose();
  }

  /// One-shot rebuild at the moment the no-show wait elapses, so the button
  /// enables itself without the driver having to leave and re-enter the screen.
  void _scheduleNoShow(RideState s) {
    _noShowTimer?.cancel();
    _noShowTimer = null;
    if (s.status != RideStatus.arrived || s.arrivedAt == null || s.noShowReady()) return;
    final remaining = s.arrivedAt!.add(kNoShowWait).difference(DateTime.now());
    if (remaining <= Duration.zero) return;
    _noShowTimer = Timer(remaining, () {
      if (mounted) setState(() {});
    });
  }

  Future<void> _openMaps(RideState state) async {
    final lat = state.navLat;
    final lng = state.navLng;
    if (lat == null || lng == null) return;
    // Android geo-intent for turn-by-turn (driver-app is Android-only Phase-0).
    await ref.read(mapsLauncherProvider)(Uri.parse('google.navigation:q=$lat,$lng&mode=d'));
  }

  Future<void> _confirmCancel() async {
    final reason = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        key: const Key('cancel_dialog'),
        title: const Text('Cancel this ride?'),
        children: [
          for (final r in _cancelReasons)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, r),
              child: Text(r),
            ),
        ],
      ),
    );
    if (reason != null && mounted) {
      await ref.read(rideProvider(widget.rideId).notifier).cancel(reason);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(rideProvider(widget.rideId));
    final theme = Theme.of(context);

    // React to terminal transitions: rating on completion, home on a cancel.
    ref.listen<RideState>(rideProvider(widget.rideId), (prev, next) {
      _scheduleNoShow(next);
      if (_routedAway) return;
      if (next.status == RideStatus.completed) {
        _routedAway = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) context.go('/rating/${widget.rideId}');
        });
      } else if (next.status == RideStatus.cancelled || next.status == RideStatus.noShow) {
        _routedAway = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) context.go('/home');
        });
      }
    });

    final actionLabel = state.status.actionLabel;
    final nextEvent = state.status.nextEvent;
    final noShowReady = state.noShowReady();

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
                    if (state.status == RideStatus.arrived) ...[
                      const SizedBox(height: 12),
                      SizedBox(
                        height: 48,
                        child: OutlinedButton(
                          key: const Key('ride_no_show_button'),
                          onPressed: noShowReady && !state.busy
                              ? () => ref.read(rideProvider(widget.rideId).notifier).reportNoShow()
                              : null,
                          child: Text(
                            noShowReady ? 'Report no-show' : 'Report no-show (wait 5 min)',
                          ),
                        ),
                      ),
                    ],
                    if (state.status.canDriverCancel) ...[
                      const SizedBox(height: 8),
                      TextButton(
                        key: const Key('ride_cancel_button'),
                        onPressed: state.busy ? null : _confirmCancel,
                        child: const Text('Cancel ride'),
                      ),
                    ],
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
        RideStatus.cancelled => 'Ride cancelled',
        RideStatus.noShow => 'Marked as no-show',
        _ => 'Active ride',
      };
}
