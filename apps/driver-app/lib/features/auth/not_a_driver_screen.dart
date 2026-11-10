import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_state.dart';
import '../../di/providers.dart';

/// Shown to a signed-in account whose role is not 'driver' (RCAB-E8.S15).
///
/// A first Google sign-in registers a client; an operator must enable the
/// account as a driver. Retry refreshes the session, and the API reads the
/// role from the database on refresh, so the router moves on to /home once
/// the role has changed.
class NotADriverScreen extends ConsumerStatefulWidget {
  const NotADriverScreen({super.key});

  @override
  ConsumerState<NotADriverScreen> createState() => _NotADriverScreenState();
}

class _NotADriverScreenState extends ConsumerState<NotADriverScreen> {
  bool _busy = false;
  String? _message;

  Future<void> _retry() async {
    setState(() {
      _busy = true;
      _message = null;
    });
    final error = await ref.read(authProvider.notifier).refreshSession();
    if (!mounted) return;
    final auth = ref.read(authProvider);
    setState(() {
      _busy = false;
      _message = error ??
          (auth is AuthStateAuthenticated && !auth.isDriver
              ? 'Still not enabled as a driver. Ask your operator, then retry.'
              : null);
    });
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);
    final label = auth is AuthStateAuthenticated ? auth.accountLabel : null;
    final theme = Theme.of(context);
    return Scaffold(
      key: const Key('not_a_driver_screen'),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.badge_outlined,
                      size: 56, color: theme.colorScheme.primary),
                  const SizedBox(height: 16),
                  Text(
                    'Not registered as a driver yet',
                    key: const Key('not_a_driver_title'),
                    style: theme.textTheme.headlineSmall,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 12),
                  if (label != null)
                    Text(
                      'Signed in as $label',
                      key: const Key('not_a_driver_account'),
                      style: theme.textTheme.titleMedium,
                      textAlign: TextAlign.center,
                    ),
                  const SizedBox(height: 12),
                  Text(
                    'This account is not enabled for driving. An operator '
                    'must enable it before you can go online. Once they have, '
                    'tap Retry.',
                    style: theme.textTheme.bodyMedium,
                    textAlign: TextAlign.center,
                  ),
                  if (_message != null) ...[
                    const SizedBox(height: 12),
                    Text(
                      _message!,
                      key: const Key('not_a_driver_message'),
                      style: TextStyle(color: theme.colorScheme.error),
                      textAlign: TextAlign.center,
                    ),
                  ],
                  const SizedBox(height: 24),
                  FilledButton(
                    key: const Key('not_a_driver_retry'),
                    onPressed: _busy ? null : _retry,
                    child: _busy
                        ? const SizedBox(
                            height: 20,
                            width: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Retry'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    key: const Key('not_a_driver_sign_out'),
                    onPressed: _busy
                        ? null
                        : () => ref.read(authProvider.notifier).signOut(),
                    child: const Text('Sign out'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
