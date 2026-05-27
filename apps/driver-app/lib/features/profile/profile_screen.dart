import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../di/providers.dart';
import 'models/vehicle.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vehiclesAsync = ref.watch(vehiclesProvider);

    return Scaffold(
      key: const Key('profile_screen'),
      appBar: AppBar(title: const Text('Profile')),
      body: vehiclesAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Failed to load vehicles: $e')),
        data: (vehicles) => vehicles.isEmpty
            ? _EmptyState(onAdd: () => context.push('/profile/vehicle/add'))
            : _VehicleList(vehicles: vehicles, onAdd: () => context.push('/profile/vehicle/add')),
      ),
      floatingActionButton: FloatingActionButton(
        key: const Key('add_vehicle_fab'),
        onPressed: () => context.push('/profile/vehicle/add'),
        child: const Icon(Icons.add),
      ),
    );
  }
}

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
    return ListTile(
      key: Key('vehicle_row_${widget.vehicle.id}'),
      title: Text('${widget.vehicle.type} · ${widget.vehicle.regNo}'),
      subtitle: Text('${widget.vehicle.make ?? ''} ${widget.vehicle.model ?? ''}'.trim()),
      trailing: _loading
          ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2))
          : ElevatedButton(
              key: Key('select_vehicle_${widget.vehicle.id}'),
              onPressed: _select,
              child: const Text('Select'),
            ),
    );
  }
}
