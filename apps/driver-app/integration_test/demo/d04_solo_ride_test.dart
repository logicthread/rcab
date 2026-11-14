// D04 — Solo offer → accept → every ride state → rating.
// A simulated passenger (host director, ordinary client session) quotes and
// books a normal ride ~900 m from the driver; the driver app is untouched
// production code with a fixture driver session.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D04 solo ride lifecycle', (tester) async {
    final demo = Demo('D04');
    await demo.boot(
      tester,
      title: const DemoTitle('Solo ride: offer → rating', [
        'ride_offer over Socket.IO, 12 s countdown, Accept',
        'accepted → en_route (first location packet) → arrived',
        '→ in_progress → completed',
        'Rating prompt → POST /v1/rides/:id/ratings',
      ]),
    );

    await demo.say('Driver goes online in Area B (Narengi)');
    await demo.goOnline();
    await demo.wait(1.5);

    await demo.say('A passenger ~1 km away requests a normal ride (quote → POST /v1/rides)');
    await demo.cue('request-ride');
    await demo.waitFor(find.byKey(const Key('offer_accept_button')), timeout: 30, what: 'offer');
    await demo.say('Offer: fare + pickup distance, countdown = dispatch.offerTtlMs (12 s)', hold: 3.5);
    await demo.tap(find.byKey(const Key('offer_accept_button')), after: 0.5);

    await demo.waitFor(find.byKey(const Key('ride_screen')), timeout: 20, what: 'ride screen');
    var s = await demo.cue('ride-status');
    await demo.say('Accepted → ride screen · passenger sees: ${s['status']}', hold: 3);

    // The server moves the ride accepted → en_route on the first location
    // packet; the app follows it live (ride:subscribe). Tap only if needed.
    await demo.say('Driving to pickup: location packets stream, server marks en_route');
    await demo.cue('drive', {'to': 'pickup', 'secs': '14'});
    await demo.wait(3);
    if (find.text('Head to pickup').evaluate().isNotEmpty) {
      await demo.tap(find.text('Head to pickup'));
    }
    await demo.waitFor(find.text("I've arrived"), timeout: 20, what: 'en_route');
    s = await demo.cue('ride-status');
    await demo.say('En route · passenger sees: ${s['status']} (and the moving car)', hold: 9);

    await demo.say('At the pickup: I\'ve arrived → arrived');
    await demo.tap(find.text("I've arrived"));
    await demo.waitFor(find.text('Start ride'), timeout: 20);
    s = await demo.cue('ride-status');
    await demo.say('Arrived · passenger sees: ${s['status']} · no-show unlocks after 5 min', hold: 3.5);

    await demo.say('Passenger aboard: Start ride → in_progress');
    await demo.tap(find.text('Start ride'));
    await demo.waitFor(find.text('End ride'), timeout: 20);
    await demo.cue('drive', {'to': 'dropoff', 'secs': '12'});
    s = await demo.cue('ride-status');
    await demo.say('In progress · navigating to dropoff · passenger sees: ${s['status']}', hold: 12);

    await demo.say('At the dropoff: End ride → completed');
    await demo.tap(find.text('End ride'));
    await demo.waitFor(find.byKey(const Key('rating_screen')), timeout: 20, what: 'rating');
    s = await demo.cue('ride-status');
    await demo.say('Completed (passenger sees: ${s['status']}) → driver rates the passenger', hold: 2);
    await demo.tap(find.byKey(const Key('rating_star_5')), after: 0.6);
    await demo.type(find.byKey(const Key('rating_text')), 'Polite, on time');
    FocusManager.instance.primaryFocus?.unfocus(); // dismiss the soft keyboard
    await demo.tap(find.byKey(const Key('rating_submit_button')));

    await demo.waitGone(find.byKey(const Key('rating_screen')), timeout: 20, what: 'rating screen');
    await demo.end(
      caption: 'Rating stored → back home, still online and dispatchable',
      hold: 4,
    );
  });
}
