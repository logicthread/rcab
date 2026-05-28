import 'package:flutter/material.dart';

class OfferScreen extends StatelessWidget {
  const OfferScreen({super.key, required this.offerId});

  final String offerId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Text(
          'Offer $offerId',
          key: const Key('offer_screen'),
        ),
      ),
    );
  }
}
