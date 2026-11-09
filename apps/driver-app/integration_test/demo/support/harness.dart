import 'dart:convert';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_app/app.dart';
import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/ride/ride_provider.dart';

import 'demo_chrome.dart';

// ── Inputs (all passed by scripts/demo/record-driver.sh as --dart-define) ─────
//
// DEMO_JWT / DEMO_REFRESH: an ordinary rcab session for a fixture driver,
//   minted on the host by integration_test/demo/host/fixtures.mjs (signed with
//   the dev stack's JWT_SECRET; refresh row stored hashed). Empty ⇒ signed out.
// DEMO_CUE_BASE: the host-side director (host/director.mjs), reached from the
//   emulator through 10.0.2.2. The director owns the screen recorder, the GPS
//   (adb emu geo fix) and the simulated passengers.
const _kJwt = String.fromEnvironment('DEMO_JWT');
const _kRefresh = String.fromEnvironment('DEMO_REFRESH');
const _kCueBase = String.fromEnvironment('DEMO_CUE_BASE', defaultValue: 'http://10.0.2.2:8787');

/// One recorded scene. Usage (see d04_solo_ride_test.dart):
///
/// ```dart
/// final demo = Demo('D04');
/// await demo.boot(tester, title: ...);
/// await demo.say('Offer arrives');
/// ```
class Demo {
  Demo(this.scene);

  final String scene;
  late WidgetTester tester;
  late ProviderContainer container;

  static IntegrationTestWidgetsFlutterBinding ensureBinding() {
    final b = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
    // Render every frame in real time so the screen recording looks natural.
    b.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
    return b;
  }

  /// Seeds the session exactly where the app keeps it (flutter_secure_storage
  /// via the app's own TokenStore), starts the real app under the demo chrome,
  /// asks the director to start recording, then shows the title card.
  Future<void> boot(
    WidgetTester t, {
    required DemoTitle title,
    bool signedIn = true,
    bool oemSheetSeen = true,
    bool grantLocation = true,
  }) async {
    tester = t;
    final store = TokenStore();
    await store.clear();
    if (signedIn && _kJwt.isNotEmpty) {
      await store.saveTokens(jwt: _kJwt, refresh: _kRefresh);
    }
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    if (oemSheetSeen) await prefs.setBool('oem_onboarding_shown', true);

    await Firebase.initializeApp();
    container = ProviderContainer(overrides: [sharedRideSenderOverride]);

    DemoChrome.caption.value = '';
    DemoChrome.titleCard.value = title;
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: DemoChrome(scene: scene, child: const DriverApp()),
      ),
    );
    // Director: GPS to Area B, location permission (pre-granted unless the
    // scene shows the system dialog), then start the screen recorder.
    await cue('ready', {'grant': grantLocation ? '1' : '0'});
    await wait(4);
    DemoChrome.titleCard.value = null;
    await wait(1);
  }

  /// Caption strip text for the next part of the scene.
  Future<void> say(String text, {double hold = 0}) async {
    DemoChrome.caption.value = text;
    if (hold > 0) await wait(hold);
  }

  /// Real-time pause (frames keep rendering).
  Future<void> wait(double seconds) =>
      tester.runAsync(() => Future<void>.delayed(Duration(milliseconds: (seconds * 1000).round())));

  /// Poll until [finder] matches, in real time. Fails the scene on timeout.
  Future<void> waitFor(Finder finder, {double timeout = 30, String? what}) async {
    final deadline = DateTime.now().add(Duration(milliseconds: (timeout * 1000).round()));
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump();
      if (finder.evaluate().isNotEmpty) return;
      await wait(0.25);
    }
    throw TestFailure('timed out after ${timeout}s waiting for ${what ?? finder}');
  }

  /// Poll until [finder] matches nothing (e.g. a screen was popped).
  Future<void> waitGone(Finder finder, {double timeout = 30, String? what}) async {
    final deadline = DateTime.now().add(Duration(milliseconds: (timeout * 1000).round()));
    while (DateTime.now().isBefore(deadline)) {
      await tester.pump();
      if (finder.evaluate().isEmpty) return;
      await wait(0.25);
    }
    throw TestFailure('timed out after ${timeout}s waiting for ${what ?? finder} to go away');
  }

  /// Tap with a short beat before and after, so the viewer can follow.
  Future<void> tap(Finder finder, {double before = 0.8, double after = 1.2}) async {
    await waitFor(finder);
    await _reveal(finder);
    await wait(before);
    await tester.tap(finder.first);
    await tester.pump();
    await wait(after);
  }

  Future<void> type(Finder finder, String text) async {
    await waitFor(finder);
    await _reveal(finder);
    await tester.tap(finder.first);
    await tester.pump();
    for (var i = 1; i <= text.length; i++) {
      await tester.enterText(finder.first, text.substring(0, i));
      await tester.pump();
      await wait(0.06);
    }
    await wait(0.4);
  }

  /// Scroll [finder] into view when it sits in a scrollable (e.g. a long form
  /// on a small phone), so the synthesised tap lands on it.
  Future<void> _reveal(Finder finder) async {
    if (find.ancestor(of: finder.first, matching: find.byType(Scrollable)).evaluate().isEmpty) return;
    await tester.ensureVisible(finder.first);
    await tester.pump();
    await wait(0.3);
  }

  /// Ask the host director to do something (start recording, request a ride,
  /// move the GPS, …). Returns its JSON answer.
  Future<Map<String, dynamic>> cue(String name, [Map<String, String> query = const {}]) async {
    return (await tester.runAsync(() async {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
      try {
        final uri = Uri.parse('$_kCueBase/cue/$name').replace(queryParameters: {'scene': scene, ...query});
        final req = await client.getUrl(uri);
        final res = await req.close().timeout(const Duration(seconds: 150));
        final body = await res.transform(utf8.decoder).join();
        if (res.statusCode != 200) throw TestFailure('cue $name -> ${res.statusCode}: $body');
        return body.isEmpty ? <String, dynamic>{} : jsonDecode(body) as Map<String, dynamic>;
      } finally {
        client.close(force: true);
      }
    }))!;
  }

  /// Home → online through the real toggle (permission pre-granted by the
  /// director, OEM sheet already seen).
  Future<void> goOnline() async {
    await waitFor(find.text('You are offline'), timeout: 20);
    await tap(find.byKey(const Key('online_toggle')));
    await waitFor(find.text('You are online'), timeout: 30, what: 'online');
  }

  /// Re-read a ride from the API, as the ride screen's own no-show timer
  /// would after the policy wait (used after `backdate-arrival`).
  Future<void> reloadRide(String rideId) =>
      container.read(rideProvider(rideId).notifier).load();

  /// Ends the scene: closing hold, then the director stops the recorder.
  Future<void> end({String? caption, double hold = 3}) async {
    if (caption != null) await say(caption);
    await wait(hold);
    await cue('end');
  }
}
