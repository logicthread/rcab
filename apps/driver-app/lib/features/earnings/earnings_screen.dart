import 'package:flutter/material.dart';

class EarningsScreen extends StatelessWidget {
  const EarningsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Earnings')),
      body: const Center(
        child: Text(
          // Was the internal tracker reference "coming in E7". There is no
          // earnings API yet (product gap, Epic E7).
          'Your trip earnings will appear here soon.',
          key: Key('earnings_screen'),
        ),
      ),
    );
  }
}
