// D06 — Shared ride: three simulated passengers on one corridor fill a pool
// (matching.maxSeats = 3 → closed_full), the pool is offered to the driver as
// one trip with an itinerary, the driver accepts, then confirms every pickup
// and drop-off stop in order until the pool completes.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D06 shared ride stops', (tester) async {
    final demo = Demo('D06');
    await demo.boot(
      tester,
      title: const DemoTitle('Shared ride: pool → stops', [
        'Pool open → 3 seats joined → closed_full → dispatched',
        'Shared offer: whole itinerary, Accept / Decline',
        'claimed → pickup ×3 → drop-off ×3 (stop:*_confirmed + echo)',
        'Last drop-off → pool completed → home with a summary',
      ]),
    );

    await demo.say('Online in Area B');
    await demo.goOnline();

    await demo.say('Three passengers on the same corridor book shared seats…');
    final seats = (await demo.cue('request-shared'))['seats'] as List;
    final pool = await demo.cue('pool');
    await demo.say('${seats.length} joins → pool ${pool['poolState']} with ${pool['seats']} seats '
        '→ dispatched as ONE trip');
    // A full pool dispatches at once; a part-filled one only when it closes
    // after matching.poolTimeoutMs (60 s), hence the generous timeout.
    await demo.waitFor(find.byKey(const Key('shared_offer_accept_button')), timeout: 90, what: 'shared offer');
    await demo.say('Shared offer: the itinerary, passengers numbered 1–3. '
        'Decline would pass it to the next driver', hold: 5);
    await demo.tap(find.byKey(const Key('shared_offer_accept_button')));

    await demo.waitFor(find.byKey(const Key('shared_ride_screen')), timeout: 20, what: 'shared ride screen');
    final claimed = await demo.cue('pool');
    await demo.say('Accepted · pool ${claimed['poolState']} · the current stop is in bold', hold: 3);

    final confirm = find.byKey(const Key('shared_ride_confirm_button'));
    String label() {
      final b = tester.widget<FilledButton>(confirm);
      return ((b.child! as Padding).child! as Text).data ?? '';
    }

    bool enabled() => tester.widget<FilledButton>(confirm).onPressed != null;

    for (var stop = 1; stop <= 6; stop++) {
      // Wait for the server's echo of the previous stop (button re-enabled).
      final deadline = DateTime.now().add(const Duration(seconds: 20));
      while (find.byKey(const Key('shared_ride_screen')).evaluate().isNotEmpty &&
          !enabled() &&
          DateTime.now().isBefore(deadline)) {
        await demo.wait(0.25);
        await tester.pump();
      }
      if (find.byKey(const Key('shared_ride_screen')).evaluate().isEmpty) break;
      final text = label();
      final pickup = text.startsWith('Picked up');
      await demo.cue('drive', {'to': pickup ? 'spick' : 'sdrop', 'leg': '0', 'secs': '4'});
      await demo.say('Stop $stop/6 · ${pickup ? 'pickup' : 'drop-off'} → tap "$text"');
      await demo.wait(3);
      await demo.tap(confirm, before: 0.2, after: 1.5);
    }

    await demo.waitGone(find.byKey(const Key('shared_ride_screen')), timeout: 20, what: 'shared ride screen');
    await demo.waitFor(find.byKey(const Key('driver_notice')), timeout: 10, what: 'completion notice');
    final done = await demo.cue('pool');
    await demo.end(
      caption: 'All 6 stops confirmed · pool ${done['poolState']} · home, still online',
      hold: 5,
    );
  });
}
