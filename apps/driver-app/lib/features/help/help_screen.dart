import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../account/account_api.dart';

/// Support conversation. Polled so a reply from the rcab team appears without a refresh.
class HelpScreen extends ConsumerStatefulWidget {
  const HelpScreen({super.key, this.pollInterval = const Duration(seconds: 5)});

  final Duration pollInterval;

  @override
  ConsumerState<HelpScreen> createState() => _HelpScreenState();
}

class _HelpScreenState extends ConsumerState<HelpScreen> {
  final _controller = TextEditingController();
  final _scroll = ScrollController();
  List<SupportMessage>? _messages;
  bool _loadFailed = false;
  bool _sending = false;
  String? _sendError;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(widget.pollInterval, (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final rows = await ref.read(accountApiProvider).supportMessages();
      if (!mounted) return;
      final grew = rows.length != (_messages?.length ?? -1);
      setState(() {
        _messages = rows;
        _loadFailed = false;
      });
      if (grew) _toEnd();
    } catch (_) {
      if (mounted && _messages == null) setState(() => _loadFailed = true);
    }
  }

  void _toEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _send() async {
    final body = _controller.text.trim();
    if (body.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _sendError = null;
    });
    try {
      final created = await ref.read(accountApiProvider).sendSupport(body);
      if (!mounted) return;
      setState(() {
        _messages = [...?_messages, ...created];
        _controller.clear();
      });
      _toEnd();
    } catch (_) {
      if (mounted) {
        setState(() => _sendError = 'Could not send your message. Check your connection and try again.');
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final msgs = _messages;
    return Scaffold(
      key: const Key('help_screen'),
      appBar: AppBar(title: const Text('Contact help')),
      body: Column(
        children: [
          Expanded(
            child: msgs == null
                ? Center(
                    child: _loadFailed
                        ? Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              const Text('Could not load the conversation.', key: Key('help_error')),
                              const SizedBox(height: 12),
                              OutlinedButton(onPressed: _load, child: const Text('Try again')),
                            ],
                          )
                        : const CircularProgressIndicator(),
                  )
                : msgs.isEmpty
                    ? const Center(
                        child: Padding(
                          padding: EdgeInsets.all(24),
                          child: Text(
                            'How can we help? Describe the problem and our team will reply here.',
                            key: Key('help_empty'),
                            textAlign: TextAlign.center,
                          ),
                        ),
                      )
                    : ListView.builder(
                        key: const Key('help_thread'),
                        controller: _scroll,
                        padding: const EdgeInsets.all(16),
                        itemCount: msgs.length,
                        itemBuilder: (_, i) => _Bubble(message: msgs[i]),
                      ),
          ),
          if (_sendError != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(_sendError!,
                  key: const Key('help_send_error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('help_input'),
                      controller: _controller,
                      minLines: 1,
                      maxLines: 4,
                      maxLength: 2000,
                      onChanged: (_) => setState(() {}),
                      decoration: const InputDecoration(
                        hintText: 'Type your message',
                        counterText: '',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  ElevatedButton(
                    key: const Key('help_send'),
                    onPressed: _controller.text.trim().isEmpty || _sending ? null : _send,
                    child: const Text('Send'),
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

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});
  final SupportMessage message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mine = !message.fromSupport;
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: mine ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          Container(
            key: Key(mine ? 'msg_user' : 'msg_support'),
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
            decoration: BoxDecoration(
              color: mine ? scheme.primary : scheme.surface,
              border: mine ? null : Border.all(color: scheme.outline),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Text(message.body, style: TextStyle(color: mine ? scheme.onPrimary : scheme.onSurface)),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 2, left: 4, right: 4),
            child: Text(
              '${message.fromSupport ? 'rcab support · ' : ''}${formatClock(message.createdAt)}',
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }
}
