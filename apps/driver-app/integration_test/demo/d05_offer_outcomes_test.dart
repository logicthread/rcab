// D05 — The three ways an offer ends without a trip: the driver declines, the
// offer expires (dispatch.offerTtlMs), or another driver wins it ("lost"). The
// rival is a second fixture driver simulated by the host director over the
// public Socket.IO protocol.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D05 offer decline / expiry / lost', (tester) async {
    final demo = Demo('D05');
    await demo.boot(
      tester,
      title: const DemoTitle('Offers that end without a trip', [
        'Decline → ride_offer_response {accept:false} → home',
        'Expiry: no answer in 12 s → offer expired → home',
        'Lost: a nearer driver accepts first → ride_offer_outcome lost',
        'Each ending explains itself on the home screen',
      ]),
    );

    await demo.say('Online in Area B');
    await demo.goOnline();

    // 1. Decline
    await demo.say('1 · Decline: a passenger requests a ride');
    await demo.cue('request-ride');
    await demo.waitFor(find.byKey(const Key('offer_decline_button')), timeout: 30, what: 'offer 1');
    await demo.wait(2);
    await demo.say('Driver taps Decline → offer resolved as declined, dispatch moves on');
    await demo.tap(find.byKey(const Key('offer_decline_button')));
    await demo.waitGone(find.byKey(const Key('offer_screen')), timeout: 10, what: 'offer after decline');
    await demo.wait(2.5);
    await demo.cue('cancel-ride');

    // 2. Expiry
    await demo.say('2 · Expiry: another request, the driver does not answer');
    await demo.cue('request-ride');
    await demo.waitFor(find.byKey(const Key('offer_countdown')), timeout: 30, what: 'offer 2');
    await demo.say('Countdown runs out (dispatch.offerTtlMs = 12 s)…');
    await demo.waitGone(find.byKey(const Key('offer_screen')), timeout: 25, what: 'offer after expiry');
    await demo.say('Expired → back home with "The offer expired"', hold: 4);
    await demo.cue('cancel-ride');

    // 3. Lost
    await demo.say('3 · Lost: a second driver is online right next to the pickup');
    await demo.cue('rival-on', {'after': '3500'});
    await demo.wait(2);
    await demo.cue('request-ride');
    await demo.waitFor(find.byKey(const Key('offer_accept_button')), timeout: 30, what: 'offer 3');
    await demo.say('Both drivers get the wave-1 offer; the rival accepts first…');
    await demo.waitGone(find.byKey(const Key('offer_screen')), timeout: 20, what: 'offer after lost');
    await demo.say('Lost → "Another driver accepted this ride"', hold: 4);
    final s = await demo.cue('ride-status');
    await demo.cue('rival-off');
    await demo.end(caption: 'Ride went to the rival (passenger sees: ${s['status']})', hold: 3);
  });
}
