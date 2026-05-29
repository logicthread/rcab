import 'package:flutter/material.dart';

import 'shared_ride_models.dart';

class StopListTile extends StatelessWidget {
  const StopListTile({
    super.key,
    required this.stopState,
    required this.isCurrent,
  });

  final StopState stopState;
  final bool isCurrent;

  @override
  Widget build(BuildContext context) {
    final stop = stopState.stop;
    final confirmed = stopState.status == StopStatus.confirmed;
    final theme = Theme.of(context);

    final color = confirmed
        ? Colors.green.shade600
        : isCurrent
            ? theme.colorScheme.primary
            : theme.colorScheme.outline;

    final icon = confirmed
        ? Icons.check_circle
        : isCurrent
            ? Icons.radio_button_checked
            : Icons.radio_button_unchecked;

    return ListTile(
      key: Key('stop_${stop.sequenceIndex}'),
      leading: Icon(icon, color: color, size: 28),
      title: Text(
        '${stop.typeLabel} · passenger ${stop.passengerId}',
        style: theme.textTheme.titleMedium?.copyWith(
          fontWeight: isCurrent ? FontWeight.bold : FontWeight.normal,
          color: confirmed ? Colors.green.shade700 : null,
        ),
      ),
      subtitle: Text(
        '#${stop.sequenceIndex + 1} · (${stop.lat.toStringAsFixed(4)}, ${stop.lng.toStringAsFixed(4)})',
      ),
      trailing: confirmed
          ? const Text(
              'DONE',
              key: Key('stop_status_done'),
              style: TextStyle(fontWeight: FontWeight.bold, color: Colors.green),
            )
          : isCurrent
              ? const Text(
                  'NEXT',
                  key: Key('stop_status_next'),
                  style: TextStyle(fontWeight: FontWeight.bold),
                )
              : null,
    );
  }
}
