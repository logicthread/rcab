import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../di/providers.dart';

const _vehicleTypes = ['auto', 'bike', 'cab_hatch', 'cab_sedan'];

class VehicleFormScreen extends ConsumerStatefulWidget {
  const VehicleFormScreen({super.key});

  @override
  ConsumerState<VehicleFormScreen> createState() => _VehicleFormScreenState();
}

class _VehicleFormScreenState extends ConsumerState<VehicleFormScreen> {
  final _formKey = GlobalKey<FormState>();
  String? _type;
  final _regNoCtrl = TextEditingController();
  final _makeCtrl = TextEditingController();
  final _modelCtrl = TextEditingController();
  final _colorCtrl = TextEditingController();
  final _seatsCtrl = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _regNoCtrl.dispose();
    _makeCtrl.dispose();
    _modelCtrl.dispose();
    _colorCtrl.dispose();
    _seatsCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _submitting = true);
    try {
      final dio = ref.read(apiClientProvider);
      await dio.post('/v1/vehicles', data: {
        'type': _type,
        'reg_no': _regNoCtrl.text.trim(),
        'make': _makeCtrl.text.trim(),
        'model': _modelCtrl.text.trim(),
        'color': _colorCtrl.text.trim(),
        'seats': int.parse(_seatsCtrl.text.trim()),
      });
      ref.invalidate(vehiclesProvider);
      if (mounted) Navigator.of(context).pop();
    } on DioException catch (e) {
      final code = e.response?.data?['code'] as String?;
      if (!mounted) return;
      if (code == 'vehicle_reg_exists') {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            key: Key('reg_exists_snackbar'),
            content: Text('You already have a vehicle with that registration number.'),
          ),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: ${e.message}')),
        );
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('vehicle_form_screen'),
      appBar: AppBar(title: const Text('Add vehicle')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            DropdownButtonFormField<String>(
              key: const Key('type_dropdown'),
              decoration: const InputDecoration(labelText: 'Vehicle type'),
              value: _type,
              items: _vehicleTypes
                  .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                  .toList(),
              onChanged: (v) => setState(() => _type = v),
              validator: (v) => v == null ? 'Vehicle type required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('reg_no_field'),
              controller: _regNoCtrl,
              decoration: const InputDecoration(labelText: 'Registration number'),
              validator: (v) =>
                  (v == null || v.trim().isEmpty) ? 'Registration number required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('make_field'),
              controller: _makeCtrl,
              decoration: const InputDecoration(labelText: 'Make'),
              validator: (v) => (v == null || v.trim().isEmpty) ? 'Make required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('model_field'),
              controller: _modelCtrl,
              decoration: const InputDecoration(labelText: 'Model'),
              validator: (v) => (v == null || v.trim().isEmpty) ? 'Model required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('color_field'),
              controller: _colorCtrl,
              decoration: const InputDecoration(labelText: 'Color'),
              validator: (v) => (v == null || v.trim().isEmpty) ? 'Color required' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('seats_field'),
              controller: _seatsCtrl,
              decoration: const InputDecoration(labelText: 'Seats'),
              keyboardType: TextInputType.number,
              validator: (v) {
                if (v == null || v.trim().isEmpty) return 'Seats required';
                final n = int.tryParse(v.trim());
                if (n == null || n < 1) return 'Seats must be at least 1';
                return null;
              },
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              key: const Key('submit_button'),
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Add vehicle'),
            ),
          ],
        ),
      ),
    );
  }
}
