import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_state.dart';
import '../../core/theme/app_theme.dart';
import '../../di/providers.dart';
import '../profile/profile_screen.dart' show confirmSignOut;

/// Side menu: profile, trip history, feedback, help, theme and sign out.
class AppDrawer extends ConsumerWidget {
  const AppDrawer({super.key});

  void _go(BuildContext context, String route) {
    // Grab the router before the drawer's context goes away.
    final router = GoRouter.of(context);
    Navigator.of(context).pop(); // close the drawer
    router.push(route);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    final account = auth is AuthStateAuthenticated ? auth.accountLabel : null;
    final mode = ref.watch(themeModeProvider);
    final text = Theme.of(context).textTheme;

    return Drawer(
      key: const Key('app_drawer'),
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Menu', style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w700)),
                  if (account != null)
                    Text(
                      account,
                      key: const Key('drawer_account'),
                      overflow: TextOverflow.ellipsis,
                      style: text.bodyMedium?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
            _Item(
              key: const Key('drawer_profile'),
              icon: Icons.person_outline,
              label: 'Profile & vehicles',
              onTap: () => _go(context, '/profile'),
            ),
            _Item(
              key: const Key('drawer_history'),
              icon: Icons.history,
              label: 'Trip history',
              onTap: () => _go(context, '/history'),
            ),
            _Item(
              key: const Key('drawer_feedback'),
              icon: Icons.rate_review_outlined,
              label: 'Give feedback',
              onTap: () => _go(context, '/feedback'),
            ),
            _Item(
              key: const Key('drawer_help'),
              icon: Icons.support_agent,
              label: 'Contact help',
              onTap: () => _go(context, '/help'),
            ),
            const Divider(height: 32),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Theme', style: text.labelLarge),
                  const SizedBox(height: 8),
                  SizedBox(
                    width: double.infinity,
                    child: SegmentedButton<ThemeMode>(
                      key: const Key('theme_selector'),
                      showSelectedIcon: false,
                      segments: const [
                        ButtonSegment(value: ThemeMode.system, label: Text('System')),
                        ButtonSegment(value: ThemeMode.light, label: Text('Light')),
                        ButtonSegment(value: ThemeMode.dark, label: Text('Dark')),
                      ],
                      selected: {mode},
                      onSelectionChanged: (s) =>
                          ref.read(themeModeProvider.notifier).set(s.first),
                    ),
                  ),
                ],
              ),
            ),
            const Spacer(),
            Padding(
              padding: const EdgeInsets.all(20),
              child: SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  key: const Key('drawer_sign_out'),
                  icon: const Icon(Icons.logout),
                  label: const Text('Sign out'),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Theme.of(context).colorScheme.error,
                  ),
                  onPressed: () async {
                    // Confirm while the drawer is still mounted, then close it.
                    await confirmSignOut(context, ref);
                    if (context.mounted) Navigator.of(context).pop();
                  },
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Item extends StatelessWidget {
  const _Item({super.key, required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
      minVerticalPadding: 14,
      onTap: onTap,
    );
  }
}
