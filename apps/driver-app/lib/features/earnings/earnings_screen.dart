import 'package:flutter/material.dart';

class EarningsScreen extends StatelessWidget {
  const EarningsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Earnings')),
      body: const Center(
        child: Text(
          'Earnings — coming in E7',
          key: Key('earnings_screen'),
        ),
      ),
    );
  }
}
