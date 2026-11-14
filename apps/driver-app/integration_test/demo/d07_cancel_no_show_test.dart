// D07 — How a solo ride ends without a trip once it is assigned:
//   1. the driver cancels (reason picker → POST /v1/rides/:id/cancel);
//   2. the passenger cancels → pushed live to the ride screen (ride_state_changed);
//   3. no-show: after `arrived` the button unlocks once rides.noShowWaitMs (5 min)
//      has passed → POST /v1/rides/:id/no-show.
// The 5-minute wait is NOT sat through: the director back-dates the ride's
// arrived_at in the dev DB (cue backdate-arrival) and the scene re-reads the ride,
// exactly what the screen's own timer does when the wait elapses. The server
// re-validates the wait against arrived_at, so the real rule is still exercised.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D07 driver cancel and no-show', (tester) async {
    final demo = Demo('D07');
    await demo.boot(
      tester,
      title: const DemoTitle('Cancel · passenger cancel · no-show', [
        'Driver cancel (accepted…in_progress) → cancelled, by=driver',
        'Passenger cancel → pushed live to the driver → home',
        'arrived + rides.noShowWaitMs (5 min) → Report no-show → no_show',
        'Each ending explains itself on the home screen',
      ]),
    );

    await demo.say('Online in Area B');
    await demo.goOnline();

    Future<String> acceptNext(String label) async {
      await demo.say(label);
      final r = await demo.cue('request-ride');
      await demo.waitFor(find.byKey(const Key('offer_accept_button')), timeout: 30, what: 'offer');
      await demo.wait(1.5);
      await demo.tap(find.byKey(const Key('offer_accept_button')), after: 0.5);
      await demo.waitFor(find.byKey(const Key('ride_screen')), timeout: 20, what: 'ride screen');
      await demo.waitFor(find.byKey(const Key('ride_cancel_button')), timeout: 20);
      return r['rideId'] as String;
    }

    // 1 · Driver cancel
    await acceptNext('1 · Driver cancel: accept a ride…');
    await demo.say('Something came up: Cancel ride → pick a reason', hold: 1.5);
    await demo.tap(find.byKey(const Key('ride_cancel_button')));
    await demo.waitFor(find.byKey(const Key('cancel_dialog')));
    await demo.wait(1.5);
    await demo.tap(find.text('Vehicle issue'));
    await demo.waitFor(find.byKey(const Key('driver_notice')), timeout: 20, what: 'cancel notice');
    var s = await demo.cue('ride-status');
    await demo.say('Cancelled by the driver → home · passenger sees: ${s['status']}', hold: 4);

    // 2 · Passenger cancel, pushed live
    await acceptNext('2 · Passenger cancel: accept another ride…');
    await demo.say('Driving to the pickup when the passenger cancels in their app…');
    await demo.cue('drive', {'to': 'pickup', 'secs': '10'});
    await demo.wait(3);
    await demo.cue('cancel-ride');
    await demo.waitGone(find.byKey(const Key('ride_screen')), timeout: 20, what: 'ride screen after passenger cancel');
    await demo.say('ride_state_changed → cancelled arrives live → "The passenger cancelled this ride"', hold: 4.5);

    // 3 · No-show
    await demo.cue('geo', {'at': 'driverStart'}); // back at the stand, ~1 km out
    final rideId = await acceptNext('3 · No-show: accept a third ride and drive to the pickup');
    await demo.cue('drive', {'to': 'pickup', 'secs': '8'});
    await demo.wait(4);
    // The server marks en_route on the first location packet; tap only if needed.
    if (find.text('Head to pickup').evaluate().isNotEmpty) await demo.tap(find.text('Head to pickup'));
    await demo.waitFor(find.text("I've arrived"), timeout: 25, what: 'en_route');
    await demo.wait(2);
    await demo.tap(find.text("I've arrived"));
    await demo.waitFor(find.byKey(const Key('ride_no_show_button')), timeout: 20);
    await demo.say('Arrived. "Report no-show" stays locked for rides.noShowWaitMs (5 min)', hold: 4);
    await demo.say('(Recording shortcut: the director back-dates arrived_at by 5 min in the dev DB)');
    await demo.cue('backdate-arrival', {'secs': '305'});
    await demo.reloadRide(rideId);
    await demo.waitFor(find.text('Report no-show'), timeout: 15, what: 'no-show unlocked');
    await demo.say('The wait is over → Report no-show unlocks', hold: 2.5);
    await demo.tap(find.text('Report no-show'));
    await demo.waitFor(find.byKey(const Key('driver_notice')), timeout: 20, what: 'no-show notice');
    s = await demo.cue('ride-status');
    await demo.say('Server re-checks the wait → ${s['status']} → home, still online', hold: 4);
    await demo.end(caption: 'Three endings: driver cancel, passenger cancel (live), no-show', hold: 3);
  });
}
