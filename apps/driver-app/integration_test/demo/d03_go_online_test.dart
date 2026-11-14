// D03 — Go online and presence. Runtime location permission, the OEM
// battery-whitelist sheet, the foreground location service, and what the
// dispatcher sees in Redis (geo index + driver:state last_seen heartbeat).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D03 go online and presence', (tester) async {
    final demo = Demo('D03');
    await demo.boot(
      tester,
      oemSheetSeen: false,
      grantLocation: false,
      title: const DemoTitle('Go online · presence', [
        'offline → online: location permission, POST /v1/drivers/online',
        'Foreground service streams driver:location over Socket.IO',
        'Redis: active_drivers geo index + driver:state last_seen',
        'Parked driver heartbeat (every 20 s) keeps presence fresh',
        'online → offline: POST /v1/drivers/offline',
      ]),
    );

    await demo.say('Signed-in driver (fixture session) lands on Home: offline', hold: 3);
    await demo.say('Tap the toggle → Android asks for location permission');
    await demo.tap(find.byKey(const Key('online_toggle')), after: 0.2);
    await demo.cue('allow');
    await demo.say('First time online: the OEM battery-whitelist sheet');
    await demo.waitFor(find.byKey(const Key('oem_sheet_title')), timeout: 20);
    await demo.wait(3);
    await demo.tap(find.text('Skip'));

    await demo.waitFor(find.text('You are online'));
    var p = await demo.cue('presence');
    await demo.say('Online. Redis active_drivers: ${p['lat']}, ${p['lng']} · '
        'last_seen ${p['lastSeenAgoS']} s ago · DB availability=${p['availability']}', hold: 5);

    await demo.say('Driving: the foreground service sends a fix every 5 s (≥ 10 m moved)');
    await demo.cue('drive', {'to': 'pickup', 'secs': '12'});
    await demo.wait(14);
    p = await demo.cue('presence');
    await demo.say('Moved → geo index now ${p['lat']}, ${p['lng']} · last_seen ${p['lastSeenAgoS']} s ago', hold: 5);

    await demo.say('Parked: no movement, the 20 s heartbeat still refreshes last_seen '
        '(server sweeps silent drivers after 60 s)');
    await demo.wait(24);
    p = await demo.cue('presence');
    await demo.say('Still present after 24 s parked · last_seen ${p['lastSeenAgoS']} s ago', hold: 5);

    await demo.say('Go offline → POST /v1/drivers/offline removes the driver from the geo index');
    await demo.tap(find.byKey(const Key('online_toggle')));
    await demo.waitFor(find.text('You are offline'), what: 'offline');
    await demo.waitGone(find.text('You are online'), what: 'online label');
    p = await demo.cue('presence');
    await demo.end(
      caption: 'Offline · in geo index: ${p['inGeoIndex']} · DB availability=${p['availability']}',
      hold: 4,
    );
  });
}
