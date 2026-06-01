import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'rating_provider.dart';

/// Post-completion rating prompt. The driver scores the other party 1–5 stars
/// with optional text; Submit persists via `POST /v1/rides/:id/ratings`, Skip
/// writes nothing. Either way the screen returns `/home`. Capture only —
/// aggregation + the rating display are Epic E7. RCAB-E4.S9.
class RatingScreen extends ConsumerStatefulWidget {
  const RatingScreen({super.key, required this.rideId});

  final String rideId;

  @override
  ConsumerState<RatingScreen> createState() => _RatingScreenState();
}

class _RatingScreenState extends ConsumerState<RatingScreen> {
  final _textController = TextEditingController();
  bool _routedAway = false;

  @override
  void dispose() {
    _textController.dispose();
    super.dispose();
  }

  void _goHome() {
    if (_routedAway) return;
    _routedAway = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.go('/home');
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(ratingProvider(widget.rideId));
    final notifier = ref.read(ratingProvider(widget.rideId).notifier);
    final theme = Theme.of(context);

    // Once the rating is recorded, leave the prompt.
    ref.listen<RatingState>(ratingProvider(widget.rideId), (prev, next) {
      if (next.submitted) _goHome();
    });

    return Scaffold(
      key: const Key('rating_screen'),
      appBar: AppBar(title: const Text('Rate this ride')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Ride ${widget.rideId}', style: theme.textTheme.bodySmall),
              const SizedBox(height: 16),
              Text('How was your trip?', style: theme.textTheme.titleMedium),
              const SizedBox(height: 12),
              Row(
                key: const Key('rating_stars'),
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var i = 1; i <= 5; i++)
                    IconButton(
                      key: Key('rating_star_$i'),
                      iconSize: 40,
                      onPressed: state.busy || state.submitted ? null : () => notifier.setStars(i),
                      icon: Icon(i <= state.stars ? Icons.star : Icons.star_border),
                    ),
                ],
              ),
              const SizedBox(height: 16),
              TextField(
                key: const Key('rating_text'),
                controller: _textController,
                enabled: !state.busy && !state.submitted,
                maxLength: 1000,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Add a comment (optional)',
                  border: OutlineInputBorder(),
                ),
              ),
              const Spacer(),
              if (state.busy)
                const Center(
                  key: Key('rating_busy'),
                  child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()),
                )
              else ...[
                SizedBox(
                  height: 56,
                  child: FilledButton(
                    key: const Key('rating_submit_button'),
                    onPressed:
                        state.canSubmit ? () => notifier.submit(_textController.text) : null,
                    child: const Text('Submit', style: TextStyle(fontSize: 18)),
                  ),
                ),
                const SizedBox(height: 8),
                TextButton(
                  key: const Key('rating_skip_button'),
                  onPressed: state.submitted ? null : _goHome,
                  child: const Text('Skip'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
