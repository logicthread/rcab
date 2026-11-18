import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/theme/app_theme.dart';
import '../account/account_api.dart';

class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final trips = ref.watch(tripHistoryProvider);
    return Scaffold(
      key: const Key('history_screen'),
      appBar: AppBar(title: const Text('Trip history')),
      body: trips.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, __) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Could not load your trips.', key: Key('history_error')),
              const SizedBox(height: 12),
              OutlinedButton(
                onPressed: () => ref.invalidate(tripHistoryProvider),
                child: const Text('Try again'),
              ),
            ],
          ),
        ),
        data: (items) => items.isEmpty
            ? const Center(
                child: Padding(
                  padding: EdgeInsets.all(24),
                  child: Text(
                    'No trips yet. Completed and cancelled trips will show up here.',
                    key: Key('history_empty'),
                    textAlign: TextAlign.center,
                  ),
                ),
              )
            : RefreshIndicator(
                onRefresh: () async => ref.refresh(tripHistoryProvider.future),
                child: ListView.separated(
                  key: const Key('history_list'),
                  padding: const EdgeInsets.all(16),
                  itemCount: items.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 10),
                  itemBuilder: (_, i) => _TripCard(trip: items[i]),
                ),
              ),
      ),
    );
  }
}

class _TripCard extends StatelessWidget {
  const _TripCard({required this.trip});
  final TripSummary trip;

  static const _labels = <String, String>{
    'requested': 'Finding driver',
    'dispatching': 'Finding driver',
    'accepted': 'Assigned',
    'en_route': 'On the way',
    'arrived': 'Arrived',
    'in_progress': 'On the trip',
    'completed': 'Completed',
    'cancelled': 'Cancelled',
    'no_driver': 'No driver found',
    'no_show': 'No-show',
  };

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final dark = scheme.brightness == Brightness.dark;
    final good = trip.status == 'completed';
    final bad = const {'cancelled', 'no_driver', 'no_show'}.contains(trip.status);
    final color = good
        ? (dark ? RcabColors.darkGo : RcabColors.lightGo)
        : bad
            ? scheme.error
            : scheme.onSurface;
    final fare = formatRupees(trip.fareCents);

    return Card(
      key: const Key('trip_card'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    formatWhen(trip.when) +
                        (trip.scheduled ? '  ·  Scheduled' : ''),
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _labels[trip.status] ?? trip.status,
                    style: TextStyle(color: color, fontWeight: FontWeight.w600),
                  ),
                ],
              ),
            ),
            Text(fare, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
          ],
        ),
      ),
    );
  }
}
