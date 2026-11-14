import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/auth/auth_state.dart';
import '../../core/driver/driver_state.dart';
import '../../di/providers.dart';
import 'models/vehicle.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vehiclesAsync = ref.watch(vehiclesProvider);

    return Scaffold(
      key: const Key('profile_screen'),
      appBar: AppBar(
        title: const Text('Profile'),
        actions: [
          IconButton(
            key: const Key('sign_out_button'),
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
            onPressed: () => _confirmSignOut(context, ref),
          ),
        ],
      ),
      body: Column(
        children: [
          const _AccountTile(),
          Expanded(
            child: vehiclesAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Text('Failed to load vehicles: $e')),
              data: (vehicles) => vehicles.isEmpty
                  ? _EmptyState(onAdd: () => context.push('/profile/vehicle/add'))
                  : _VehicleList(vehicles: vehicles, onAdd: () => context.push('/profile/vehicle/add')),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        key: const Key('add_vehicle_fab'),
        onPressed: () => context.push('/profile/vehicle/add'),
        child: const Icon(Icons.add),
      ),
    );
  }
}

/// Who is signed in: the Google email, or the phone for a phone account
/// (RCAB-E8.S15: Google accounts have no phone). Hidden when neither is
/// known, e.g. a session restored on a build that never stored it.
class _AccountTile extends ConsumerWidget {
  const _AccountTile();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);
    final label = auth is AuthStateAuthenticated ? auth.accountLabel : null;
    if (label == null) return const SizedBox.shrink();
    return ListTile(
      key: const Key('account_tile'),
      leading: const Icon(Icons.account_circle_outlined),
      title: Text(label, key: const Key('account_label')),
      subtitle: const Text('Signed in'),
    );
  }
}

/// Sign out (RCAB-E8.S14): the app had no way to end a session. Goes offline
/// first (best effort), then `AuthNotifier.signOut` revokes the refresh token
/// server-side and clears secure storage; the router returns to /sign-in.
Future<void> _confirmSignOut(BuildContext context, WidgetRef ref) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      key: const Key('sign_out_dialog'),
      title: const Text('Sign out?'),
      content: const Text('You will go offline and stop receiving ride offers.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(
          key: const Key('sign_out_confirm'),
          onPressed: () => Navigator.pop(ctx, true),
          child: const Text('Sign out'),
        ),
      ],
    ),
  );
  if (ok != true) return;
  if (ref.read(driverStateProvider) is DriverOnline) {
    await ref.read(driverStateProvider.notifier).goOffline();
  }
  await ref.read(authProvider.notifier).signOut();
}

/// The vehicle picked on this screen during this app session. The server
/// stores the current vehicle; this only drives the "Selected" marker.
final selectedVehicleIdProvider = StateProvider<String?>((_) => null);

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.onAdd});
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'No vehicles registered',
            key: Key('empty_state_label'),
          ),
          const SizedBox(height: 16),
          ElevatedButton(
            key: const Key('add_vehicle_button'),
            onPressed: onAdd,
            child: const Text('Add vehicle'),
          ),
        ],
      ),
    );
  }
}

class _VehicleList extends ConsumerWidget {
  const _VehicleList({required this.vehicles, required this.onAdd});
  final List<Vehicle> vehicles;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return ListView.builder(
      key: const Key('vehicle_list'),
      itemCount: vehicles.length,
      itemBuilder: (context, i) => _VehicleRow(vehicle: vehicles[i]),
    );
  }
}

class _VehicleRow extends ConsumerStatefulWidget {
  const _VehicleRow({required this.vehicle});
  final Vehicle vehicle;

  @override
  ConsumerState<_VehicleRow> createState() => _VehicleRowState();
}

class _VehicleRowState extends ConsumerState<_VehicleRow> {
  bool _loading = false;

  Future<void> _select() async {
    setState(() => _loading = true);
    try {
      final dio = ref.read(apiClientProvider);
      await dio.patch('/v1/drivers/me/vehicle', data: {'vehicle_id': widget.vehicle.id});
      // Keep the driver state in step with the server's current vehicle.
      ref.read(driverStateProvider.notifier).updateVehicleId(widget.vehicle.id);
      ref.read(selectedVehicleIdProvider.notifier).state = widget.vehicle.id;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            key: const Key('vehicle_selected_snackbar'),
            content: Text('${widget.vehicle.regNo} is now your current vehicle'),
          ),
        );
      }
      ref.invalidate(vehiclesProvider);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Failed to select vehicle: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // A pick made in this session wins; otherwise trust the server, so a fresh
    // install still shows which vehicle going online will use.
    final picked = ref.watch(selectedVehicleIdProvider);
    final selected = picked != null ? picked == widget.vehicle.id : widget.vehicle.isCurrent;
    return ListTile(
      key: Key('vehicle_row_${widget.vehicle.id}'),
      title: Text('${vehicleTypeLabel(widget.vehicle.type)} · ${widget.vehicle.regNo}'),
      subtitle: Text('${widget.vehicle.make ?? ''} ${widget.vehicle.model ?? ''}'.trim()),
      trailing: _loading
          ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))
          : selected
              ? Chip(
                  key: Key('selected_vehicle_${widget.vehicle.id}'),
                  avatar: const Icon(Icons.check, size: 18),
                  label: const Text('Selected'),
                )
              : ElevatedButton(
                  key: Key('select_vehicle_${widget.vehicle.id}'),
                  onPressed: _select,
                  child: const Text('Select'),
                ),
    );
  }
}
