import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/core/theme/app_theme.dart';
import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/account/account_api.dart';
import 'package:driver_app/features/feedback/feedback_screen.dart';
import 'package:driver_app/features/help/help_screen.dart';
import 'package:driver_app/features/history/history_screen.dart';
import 'package:driver_app/features/menu/app_drawer.dart';

class MockAccountApi extends Mock implements AccountApi {}

class MockDio extends Mock implements Dio {}

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

class _MemTokenStore extends TokenStore {
  @override
  Future<String?> getJwt() async => 'jwt';
  @override
  Future<String?> getRefresh() async => 'refresh';
  @override
  Future<void> clear() async {}
}

Widget _app(Widget home, List<Override> overrides) => ProviderScope(
      overrides: overrides,
      child: MaterialApp(theme: buildTheme(Brightness.light), home: home),
    );

SupportMessage _msg(String id, {required bool support, required String body}) =>
    SupportMessage(id: id, fromSupport: support, body: body, createdAt: DateTime(2026, 11, 18, 19, 5));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('feedback screen', () {
    testWidgets('cannot send empty, then posts the category and text', (tester) async {
      final api = MockAccountApi();
      when(() => api.sendFeedback(any(), any())).thenAnswer((_) async {});
      await tester.pumpWidget(_app(const FeedbackScreen(), [accountApiProvider.overrideWithValue(api)]));

      final submit = find.byKey(const Key('feedback_submit'));
      expect(tester.widget<ElevatedButton>(submit).onPressed, isNull);

      await tester.tap(find.byKey(const Key('feedback_bug')));
      await tester.enterText(find.byKey(const Key('feedback_message')), '  app froze ');
      await tester.pump();
      await tester.tap(submit);
      await tester.pumpAndSettle();

      verify(() => api.sendFeedback('bug', 'app froze')).called(1);
      expect(find.byKey(const Key('feedback_sent')), findsOneWidget);
    });

    testWidgets('explains a failed send and keeps the text', (tester) async {
      final api = MockAccountApi();
      when(() => api.sendFeedback(any(), any())).thenThrow(Exception('down'));
      await tester.pumpWidget(_app(const FeedbackScreen(), [accountApiProvider.overrideWithValue(api)]));
      await tester.enterText(find.byKey(const Key('feedback_message')), 'hello');
      await tester.pump();
      await tester.tap(find.byKey(const Key('feedback_submit')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('feedback_error')), findsOneWidget);
      expect(find.text('hello'), findsOneWidget);
    });
  });

  group('help screen', () {
    testWidgets('empty thread, then shows the conversation after sending', (tester) async {
      final api = MockAccountApi();
      when(() => api.supportMessages()).thenAnswer((_) async => []);
      when(() => api.sendSupport(any())).thenAnswer((_) async => [
            _msg('1', support: false, body: 'rider was rude'),
            _msg('2', support: true, body: 'Thanks for reaching out.'),
          ]);
      await tester.pumpWidget(_app(
        const HelpScreen(pollInterval: Duration(hours: 1)),
        [accountApiProvider.overrideWithValue(api)],
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('help_empty')), findsOneWidget);

      await tester.enterText(find.byKey(const Key('help_input')), 'rider was rude');
      await tester.pump();
      await tester.tap(find.byKey(const Key('help_send')));
      await tester.pumpAndSettle();

      verify(() => api.sendSupport('rider was rude')).called(1);
      expect(find.byKey(const Key('msg_user')), findsOneWidget);
      expect(find.byKey(const Key('msg_support')), findsOneWidget);
      expect(find.textContaining('rcab support'), findsOneWidget);
    });

    testWidgets('offers a retry when the thread cannot load', (tester) async {
      final api = MockAccountApi();
      when(() => api.supportMessages()).thenThrow(Exception('offline'));
      await tester.pumpWidget(_app(
        const HelpScreen(pollInterval: Duration(hours: 1)),
        [accountApiProvider.overrideWithValue(api)],
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('help_error')), findsOneWidget);
    });
  });

  group('trip history screen', () {
    testWidgets('lists trips with fare and readable status', (tester) async {
      final trips = [
        TripSummary(
            rideId: 'r1', status: 'completed', fareCents: 18500, when: DateTime(2026, 11, 17, 8), scheduled: false),
        TripSummary(
            rideId: 'r2', status: 'cancelled', fareCents: 9000, when: DateTime(2026, 11, 16, 9), scheduled: true),
      ];
      await tester.pumpWidget(_app(
        const HistoryScreen(),
        [tripHistoryProvider.overrideWith((_) async => trips)],
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('trip_card')), findsNWidgets(2));
      expect(find.text('₹185.00'), findsOneWidget);
      expect(find.text('Completed'), findsOneWidget);
      expect(find.text('Cancelled'), findsOneWidget);
      expect(find.textContaining('Scheduled'), findsOneWidget);
    });

    testWidgets('empty state', (tester) async {
      await tester.pumpWidget(_app(
        const HistoryScreen(),
        [tripHistoryProvider.overrideWith((_) async => <TripSummary>[])],
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('history_empty')), findsOneWidget);
    });

    testWidgets('error state', (tester) async {
      await tester.pumpWidget(_app(
        const HistoryScreen(),
        [tripHistoryProvider.overrideWith((_) async => throw Exception('x'))],
      ));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('history_error')), findsOneWidget);
    });
  });

  group('app drawer', () {
    List<Override> authOverride() => [
          authProvider.overrideWith((ref) => AuthNotifier(
                _MemTokenStore(),
                MockFirebaseAuth(),
                MockDio(),
                initialState: const AuthStateAuthenticated(userId: 'd1'),
              )),
        ];

    Widget homeWithRouter(List<Override> overrides) {
      final router = GoRouter(routes: [
        GoRoute(
          path: '/',
          builder: (_, __) => Scaffold(
            appBar: AppBar(title: const Text('home')),
            drawer: const AppDrawer(),
          ),
        ),
        GoRoute(path: '/history', builder: (_, __) => const Text('history page')),
        GoRoute(path: '/feedback', builder: (_, __) => const Text('feedback page')),
        GoRoute(path: '/help', builder: (_, __) => const Text('help page')),
        GoRoute(path: '/profile', builder: (_, __) => const Text('profile page')),
      ]);
      return ProviderScope(
        overrides: overrides,
        child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router),
      );
    }

    testWidgets('lists every destination and navigates', (tester) async {
      await tester.pumpWidget(homeWithRouter(authOverride()));
      for (final entry in {
        'drawer_profile': 'profile page',
        'drawer_history': 'history page',
        'drawer_feedback': 'feedback page',
        'drawer_help': 'help page',
      }.entries) {
        await tester.tap(find.byTooltip('Open navigation menu'));
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('drawer_sign_out')), findsOneWidget);
        await tester.tap(find.byKey(Key(entry.key)));
        await tester.pumpAndSettle();
        expect(find.text(entry.value), findsOneWidget);
        tester.state<NavigatorState>(find.byType(Navigator).first).pop();
        await tester.pumpAndSettle();
      }
    });

    testWidgets('theme selector switches the theme mode and remembers it', (tester) async {
      await tester.pumpWidget(homeWithRouter(authOverride()));
      await tester.tap(find.byTooltip('Open navigation menu'));
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(tester.element(find.byType(AppDrawer)));
      expect(container.read(themeModeProvider), ThemeMode.system);
      await tester.tap(find.text('Dark'));
      await tester.pumpAndSettle();
      expect(container.read(themeModeProvider), ThemeMode.dark);
      expect((await SharedPreferences.getInstance()).getString(ThemeModeNotifier.prefKey), 'dark');
    });
  });

  group('theme', () {
    test('light and dark share the amber accent and flip ink/paper', () {
      final light = buildTheme(Brightness.light);
      final dark = buildTheme(Brightness.dark);
      expect(light.colorScheme.secondary, RcabColors.amber);
      expect(dark.colorScheme.secondary, RcabColors.amber);
      expect(light.colorScheme.primary, RcabColors.lightInk);
      expect(dark.colorScheme.primary, RcabColors.darkInk);
      expect(light.scaffoldBackgroundColor, RcabColors.lightPaper);
      expect(dark.scaffoldBackgroundColor, RcabColors.darkPaper);
    });

    test('formatters', () {
      expect(formatRupees(18500), '₹185.00');
      expect(formatClock(DateTime(2026, 1, 1, 0, 5)), '12:05 AM');
      expect(formatClock(DateTime(2026, 1, 1, 19, 30)), '7:30 PM');
      expect(formatWhen(DateTime(2026, 11, 18, 19, 5)), '18 Nov, 7:05 PM');
    });
  });
}
