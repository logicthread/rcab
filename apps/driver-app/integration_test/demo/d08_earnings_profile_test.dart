// D08 — Earnings, profile and sign-out. Earnings is a placeholder (no earnings
// API yet: product gap, Epic E7). Profile lists the driver's vehicles
// (GET /v1/vehicles) and selects the current one (PATCH /v1/drivers/me/vehicle).
// Sign out goes offline first, then POST /v1/auth/native/logout revokes the
// refresh token server-side and secure storage is cleared → /sign-in.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D08 earnings, profile and sign-out', (tester) async {
    final demo = Demo('D08');
    await demo.boot(
      tester,
      title: const DemoTitle('Earnings · profile · sign out', [
        'Earnings: placeholder (no earnings API yet, Epic E7)',
        'Profile: GET /v1/vehicles, Select → PATCH /v1/drivers/me/vehicle',
        'Sign out: offline → POST /v1/auth/native/logout (refresh revoked)',
        'Secure storage cleared → router back to /sign-in',
      ]),
    );

    await demo.say('Signed in, online in Area B');
    await demo.goOnline();

    await demo.say('Earnings (wallet icon)');
    await demo.tap(find.byKey(const Key('earnings_button')));
    await demo.waitFor(find.byKey(const Key('earnings_screen')));
    await demo.say('Placeholder only: there is no earnings API yet (Epic E7)', hold: 4);
    await demo.tap(find.byTooltip('Back'));

    await demo.say('Profile & vehicles (person icon)');
    await demo.tap(find.byKey(const Key('profile_button')));
    await demo.waitFor(find.byKey(const Key('vehicle_list')), what: 'vehicle list');
    await demo.say('GET /v1/vehicles → the driver\'s registered vehicles', hold: 3);
    await demo.tap(find.widgetWithText(ElevatedButton, 'Select'));
    await demo.waitFor(find.byKey(const Key('vehicle_selected_snackbar')), timeout: 15);
    await demo.say('Select → PATCH /v1/drivers/me/vehicle: the next go-online uses it', hold: 3.5);

    var sess = await demo.cue('session');
    await demo.say('Sign out (top right) · live refresh tokens on the server: ${sess['live']}');
    await demo.tap(find.byKey(const Key('sign_out_button')));
    await demo.waitFor(find.byKey(const Key('sign_out_dialog')));
    await demo.wait(2);
    await demo.tap(find.byKey(const Key('sign_out_confirm')));
    await demo.waitFor(find.byKey(const Key('send_otp_button')), timeout: 20, what: 'sign-in screen');

    sess = await demo.cue('session');
    final p = await demo.cue('presence');
    await demo.say('Back at /sign-in · refresh token revoked: ${sess['revokedJustNow']} · '
        'live: ${sess['live']} · driver ${p['availability']}', hold: 5);
    await demo.end(caption: 'Signed out: offline first, session revoked server-side, storage cleared', hold: 3);
  });
}
