// Smoke test: app boots and shows the sign-in screen when unauthenticated.
// More thorough routing tests live in test/routing/app_router_test.dart.

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/app.dart';
import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/di/providers.dart';

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

class _FakeTokenStore extends TokenStore {
  final Map<String, String> _data = {};

  @override
  Future<void> saveTokens({required String jwt, required String refresh}) async {
    _data['rcab_jwt'] = jwt;
    _data['rcab_refresh_token'] = refresh;
  }

  @override
  Future<String?> getJwt() async => _data['rcab_jwt'];

  @override
  Future<String?> getRefresh() async => _data['rcab_refresh_token'];

  @override
  Future<void> clear() async => _data.clear();
}

void main() {
  testWidgets('cold launch (unauthenticated) shows sign-in screen',
      (tester) async {
    final store = _FakeTokenStore();
    final mockFb = MockFirebaseAuth();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(store),
          firebaseAuthProvider.overrideWithValue(mockFb),
          authProvider.overrideWith(
            (ref) =>
                AuthNotifier(store, mockFb, Dio())
                  ..state = const AuthStateUnauthenticated(),
          ),
        ],
        child: const DriverApp(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('sign_in_screen')), findsOneWidget);
  });
}
