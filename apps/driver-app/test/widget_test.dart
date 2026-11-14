// Smoke test: app boots and shows the sign-in screen when unauthenticated.
// More thorough routing tests live in test/routing/app_router_test.dart.

import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/app.dart';
import 'package:driver_app/core/auth/auth_config.dart';
import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/di/providers.dart';

import 'support/fake_realtime_socket.dart';

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
          authConfigProvider.overrideWith(
            (ref) async => const AuthConfig(methods: {'google'}),
          ),
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

  // Regression (RCAB-E8.S15): the realtime socket joins `driver:<id>` only for
  // a driver token, so a role change (operator enables the account, driver taps
  // Retry), another account, or a sign-out must reopen or close it.
  testWidgets('reopens the realtime socket when the identity or role changes',
      (tester) async {
    final store = _FakeTokenStore();
    final mockFb = MockFirebaseAuth();
    final socket = FakeRealtimeSocket();
    late AuthNotifier auth;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          tokenStoreProvider.overrideWithValue(store),
          firebaseAuthProvider.overrideWithValue(mockFb),
          realtimeSocketProvider.overrideWithValue(socket),
          authConfigProvider.overrideWith(
            (ref) async => const AuthConfig(methods: {'google'}),
          ),
          authProvider.overrideWith((ref) => auth = AuthNotifier(store, mockFb, Dio())
            ..state = const AuthStateAuthenticated(userId: 'u1', role: 'client')),
        ],
        child: const DriverApp(),
      ),
    );
    await tester.pump();
    expect((socket.connects, socket.disconnects), (2, 0)); // offer + shared-ride controllers

    auth.state = const AuthStateAuthenticated(userId: 'u1', role: 'client');
    await tester.pump();
    expect((socket.connects, socket.disconnects), (2, 0), reason: 'same identity: keep the socket');

    auth.state = const AuthStateAuthenticated(userId: 'u1', role: 'driver');
    await tester.pump();
    expect((socket.connects, socket.disconnects), (4, 1), reason: 'role change: reconnect');

    auth.state = const AuthStateAuthenticated(userId: 'u2', role: 'driver');
    await tester.pump();
    expect((socket.connects, socket.disconnects), (6, 2), reason: 'other account: reconnect');

    auth.state = const AuthStateUnauthenticated();
    await tester.pump();
    expect((socket.connects, socket.disconnects), (6, 3), reason: 'sign-out: close');
  });
}
