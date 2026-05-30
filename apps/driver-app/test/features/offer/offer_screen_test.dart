import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:driver_app/features/offer/offer_models.dart';
import 'package:driver_app/features/offer/offer_provider.dart';
import 'package:driver_app/features/offer/offer_screen.dart';

class _CaptureSender implements OfferResponseSender {
  final List<({String offerId, bool accept})> sent = [];

  @override
  void sendOfferResponse({required String offerId, required bool accept}) {
    sent.add((offerId: offerId, accept: accept));
  }
}

SoloRideOffer _offer() => SoloRideOffer.tryFromRideOfferJson({
      'offerId': 'o-1',
      'rideId': 'r-1',
      'ttlMs': 12000,
      'pickup': {'lat': 26.1445, 'lng': 91.7362},
      'dropoff': {'lat': 26.1805, 'lng': 91.7500},
      'fareCents': 25000,
      'waveNumber': 1,
    })!;

void main() {
  // OfferScreen.initState fires HapticFeedback + SystemSound on a ringing
  // offer; both go through SystemChannels.platform. Swallow them in tests.
  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
  });
  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<(_CaptureSender, ProviderContainer)> pump(
    WidgetTester tester, {
    bool seed = true,
  }) async {
    final sender = _CaptureSender();
    final container = ProviderContainer(
      overrides: [offerResponseSenderProvider.overrideWithValue(sender)],
    );
    addTearDown(container.dispose);
    if (seed) container.read(offerProvider.notifier).applyOffer(_offer());
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(home: OfferScreen(offerId: 'o-1')),
      ),
    );
    return (sender, container);
  }

  testWidgets('renders fare, pickup, dropoff, countdown + Accept/Decline',
      (tester) async {
    await pump(tester);
    expect(find.byKey(const Key('offer_screen')), findsOneWidget);
    expect(find.byKey(const Key('offer_fare')), findsOneWidget);
    expect(find.text('₹250.00'), findsOneWidget);
    expect(find.byKey(const Key('offer_countdown')), findsOneWidget);
    expect(find.text('12s'), findsOneWidget);
    expect(find.textContaining('Pickup'), findsOneWidget);
    expect(find.textContaining('Dropoff'), findsOneWidget);
    expect(find.byKey(const Key('offer_accept_button')), findsOneWidget);
    expect(find.byKey(const Key('offer_decline_button')), findsOneWidget);
  });

  testWidgets('Accept tap emits accept:true + shows claiming', (tester) async {
    final (sender, container) = await pump(tester);
    await tester.tap(find.byKey(const Key('offer_accept_button')));
    await tester.pump();
    expect(sender.sent.single.offerId, 'o-1');
    expect(sender.sent.single.accept, isTrue);
    expect(container.read(offerProvider).phase, OfferPhase.claiming);
    expect(find.byKey(const Key('offer_claiming')), findsOneWidget);
    expect(find.byKey(const Key('offer_accept_button')), findsNothing);
  });

  testWidgets('Decline tap emits accept:false', (tester) async {
    final (sender, _) = await pump(tester);
    await tester.tap(find.byKey(const Key('offer_decline_button')));
    await tester.pump();
    expect(sender.sent.single.accept, isFalse);
  });

  testWidgets('idle (no offer) still renders the offer_screen key', (tester) async {
    await pump(tester, seed: false);
    expect(find.byKey(const Key('offer_screen')), findsOneWidget);
    expect(find.text('Waiting for an offer…'), findsOneWidget);
  });
}
