// D01 — Sign-in screen (UI only). Google sign-in is NOT exercised: a recording
// cannot complete Google's account picker / consent, so it stops before the
// button is pressed. The flow behind it is narrated in the captions.
//
// RCAB-E8.S15: until launch, Google is the only sign-in method. The screen asks
// `GET /v1/auth/config` and renders only the enabled methods, so the phone/OTP
// form is deliberately absent here (it returns when the OTP provider is wired).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/demo_chrome.dart';
import 'support/harness.dart';

void main() {
  Demo.ensureBinding();

  testWidgets('D01 sign-in screen', (tester) async {
    final demo = Demo('D01');
    await demo.boot(
      tester,
      signedIn: false,
      title: const DemoTitle('Sign in with Google', [
        'Cold start with no stored session → /sign-in',
        'GET /v1/auth/config → which methods are enabled',
        'Continue with Google → Google ID token',
        'POST /v1/auth/native/google → tokens in secure storage',
      ]),
    );

    await demo.say('No session in secure storage → router redirects to /sign-in', hold: 3);
    await demo.waitFor(find.byKey(const Key('google_sign_in_button')),
        what: 'the Continue with Google button (is the dev api up with /v1/auth/config?)');
    await demo.say('GET /v1/auth/config → methods: [google]. Only enabled methods are drawn', hold: 4);
    expect(find.byKey(const Key('phone_field')), findsNothing);
    await demo.say('Phone / OTP is switched off by policy (auth.enabledMethods): no phone field, no SMS', hold: 4);
    await demo.say('Continue with Google → account picker → Google ID token '
        '(not pressed in this recording)', hold: 4);
    await demo.say('POST /v1/auth/native/google → login by Google subject, or first-use registration '
        '→ access + refresh tokens in secure storage → /home', hold: 5);
    await demo.end();
  });
}
