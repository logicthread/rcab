import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../account/account_api.dart';

class FeedbackScreen extends ConsumerStatefulWidget {
  const FeedbackScreen({super.key});

  @override
  ConsumerState<FeedbackScreen> createState() => _FeedbackScreenState();
}

class _FeedbackScreenState extends ConsumerState<FeedbackScreen> {
  static const _categories = <String, String>{
    'bug': 'Something is broken',
    'idea': 'Idea',
    'compliment': 'Compliment',
    'other': 'Other',
  };
  static const _max = 2000;

  final _controller = TextEditingController();
  String _category = 'idea';
  bool _busy = false;
  bool _sent = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(accountApiProvider).sendFeedback(_category, text);
      if (mounted) setState(() => _sent = true);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not send your feedback. Check your connection and try again.');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_sent) {
      return Scaffold(
        key: const Key('feedback_screen'),
        appBar: AppBar(title: const Text('Give feedback')),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Thanks, we got it',
                    key: const Key('feedback_sent'),
                    style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 8),
                const Text('Your feedback was sent to the rcab team.'),
                const SizedBox(height: 24),
                ElevatedButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                  child: const Text('Done'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final canSend = _controller.text.trim().isNotEmpty && !_busy;
    return Scaffold(
      key: const Key('feedback_screen'),
      appBar: AppBar(title: const Text('Give feedback')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('What is it about?', style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final e in _categories.entries)
                ChoiceChip(
                  key: Key('feedback_${e.key}'),
                  label: Text(e.value),
                  selected: _category == e.key,
                  onSelected: (_) => setState(() => _category = e.key),
                ),
            ],
          ),
          const SizedBox(height: 20),
          TextField(
            key: const Key('feedback_message'),
            controller: _controller,
            maxLines: 6,
            maxLength: _max,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: 'Tell us more',
              hintText: 'What happened, or what would make rcab better?',
              alignLabelWithHint: true,
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!,
                key: const Key('feedback_error'),
                style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ],
          const SizedBox(height: 16),
          ElevatedButton(
            key: const Key('feedback_submit'),
            onPressed: canSend ? _send : null,
            child: _busy
                ? const SizedBox(
                    height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                : const Text('Send feedback'),
          ),
        ],
      ),
    );
  }
}
