import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:driver_app/features/rating/rating_provider.dart';
import 'package:driver_app/features/rating/rating_screen.dart';

class _FakeRatingService implements RatingService {
  _FakeRatingService({this.error});

  final Object? error;
  final List<({int stars, String? text})> calls = [];

  @override
  Future<void> submit(String rideId, int stars, String? text) async {
    calls.add((stars: stars, text: text));
    if (error != null) throw error!;
  }
}

Future<_FakeRatingService> _pump(WidgetTester tester, {Object? error}) async {
  final svc = _FakeRatingService(error: error);
  final router = GoRouter(
    initialLocation: '/rating/r-1',
    routes: [
      GoRoute(
        path: '/rating/:id',
        builder: (_, s) => RatingScreen(rideId: s.pathParameters['id']!),
      ),
      GoRoute(
        path: '/home',
        builder: (_, __) => const Scaffold(body: Text('HOME', key: Key('home_marker'))),
      ),
    ],
  );
  await tester.pumpWidget(
    ProviderScope(
      overrides: [ratingServiceProvider.overrideWithValue(svc)],
      child: MaterialApp.router(routerConfig: router),
    ),
  );
  await tester.pumpAndSettle();
  return svc;
}

void main() {
  testWidgets('renders stars + submit (disabled) + skip', (tester) async {
    await _pump(tester);
    expect(find.byKey(const Key('rating_screen')), findsOneWidget);
    expect(find.byKey(const Key('rating_stars')), findsOneWidget);
    expect(find.byKey(const Key('rating_skip_button')), findsOneWidget);
    final submit = tester.widget<FilledButton>(find.byKey(const Key('rating_submit_button')));
    expect(submit.onPressed, isNull); // disabled until a star is chosen
  });

  testWidgets('choosing a star enables Submit', (tester) async {
    await _pump(tester);
    await tester.tap(find.byKey(const Key('rating_star_4')));
    await tester.pump();
    final submit = tester.widget<FilledButton>(find.byKey(const Key('rating_submit_button')));
    expect(submit.onPressed, isNotNull);
  });

  testWidgets('Submit posts the rating and routes /home', (tester) async {
    final svc = await _pump(tester);
    await tester.tap(find.byKey(const Key('rating_star_5')));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('rating_text')), 'smooth');
    await tester.tap(find.byKey(const Key('rating_submit_button')));
    await tester.pumpAndSettle();

    expect(svc.calls.single, (stars: 5, text: 'smooth'));
    expect(find.byKey(const Key('home_marker')), findsOneWidget);
  });

  testWidgets('Skip routes /home without posting', (tester) async {
    final svc = await _pump(tester);
    await tester.tap(find.byKey(const Key('rating_skip_button')));
    await tester.pumpAndSettle();

    expect(svc.calls, isEmpty);
    expect(find.byKey(const Key('home_marker')), findsOneWidget);
  });

  testWidgets('a failed submit keeps the prompt open (no nav)', (tester) async {
    final svc = await _pump(tester, error: Exception('network'));
    await tester.tap(find.byKey(const Key('rating_star_3')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('rating_submit_button')));
    await tester.pumpAndSettle();

    expect(svc.calls.length, 1);
    expect(find.byKey(const Key('home_marker')), findsNothing);
    expect(find.byKey(const Key('rating_screen')), findsOneWidget);
  });
}
