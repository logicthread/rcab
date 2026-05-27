import 'package:flutter/material.dart';

class RideScreen extends StatelessWidget {
  const RideScreen({super.key, required this.rideId});

  final String rideId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Text(
          'Ride $rideId',
          key: const Key('ride_screen'),
        ),
      ),
    );
  }
}
