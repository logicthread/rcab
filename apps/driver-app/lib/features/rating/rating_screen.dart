import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

class RatingScreen extends StatelessWidget {
  const RatingScreen({super.key, required this.rideId});

  final String rideId;

  // Placeholder. Full UI lands in RCAB-E7.S1 (rating store + UI).
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Rate this ride')),
      body: Center(
        key: const Key('rating_screen'),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Ride $rideId',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 16),
              const Text(
                'Rating UI lands in RCAB-E7.S1. Tap Done to return home.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              FilledButton(
                key: const Key('rating_done_button'),
                onPressed: () => context.go('/home'),
                child: const Text('Done'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
