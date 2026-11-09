// D01 — Sign-in screen (UI only). Real Firebase phone OTP is NOT exercised:
// the recording stops before "Send OTP" is pressed with a valid number, so no
// SMS is sent. The flow behind it is narrated in the caption.
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
      title: const DemoTitle('Sign in with phone OTP', [
        'Cold start with no stored session → /sign-in',
        'E.164 phone validation',
        'Send OTP → Firebase SMS → 6-digit code step',
        'Code → POST /v1/auth/native/firebase-exchange',
      ]),
    );

    await demo.say('No session in secure storage → router redirects to /sign-in', hold: 3);
    await demo.say('Validation: the number must be E.164 (+<country><number>)');
    await demo.type(find.byKey(const Key('phone_field')), '98300 70001');
    await demo.tap(find.byKey(const Key('send_otp_button')), after: 2.5);

    await demo.say('A valid E.164 number enables the OTP request');
    await demo.tester.enterText(find.byKey(const Key('phone_field')), '');
    await demo.type(find.byKey(const Key('phone_field')), '+919830070001');
    await demo.wait(1.5);
    await demo.say('Send OTP → Firebase verifyPhoneNumber → SMS (not sent in this recording)', hold: 4);
    await demo.say('Then: code step → Firebase ID token → /v1/auth/native/firebase-exchange → '
        'access + refresh tokens in secure storage → /home', hold: 5);
    await demo.end();
  });
}
