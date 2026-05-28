import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/auth/sign_in_screen.dart';

// ---------------------------------------------------------------------------
// Fakes & mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

Widget _buildScreen(MockFirebaseAuth mockFb) {
  final store = _FakeTokenStore();
  return ProviderScope(
    overrides: [
      tokenStoreProvider.overrideWithValue(store),
      firebaseAuthProvider.overrideWithValue(mockFb),
      authProvider.overrideWith(
        (ref) => AuthNotifier(store, mockFb, Dio()),
      ),
    ],
    child: const MaterialApp(home: SignInScreen()),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  late MockFirebaseAuth mockFb;

  setUpAll(() {
    registerFallbackValue(const Duration());
    registerFallbackValue(
      (PhoneAuthCredential _) {} as PhoneVerificationCompleted,
    );
    registerFallbackValue(
      (FirebaseAuthException _) {} as PhoneVerificationFailed,
    );
    registerFallbackValue(
      (String _, int? __) {} as PhoneCodeSent,
    );
    registerFallbackValue(
      (String _) {} as PhoneCodeAutoRetrievalTimeout,
    );
  });

  setUp(() {
    mockFb = MockFirebaseAuth();
  });

  testWidgets('shows phone field and Send OTP button', (tester) async {
    await tester.pumpWidget(_buildScreen(mockFb));

    expect(find.byKey(const Key('phone_field')), findsOneWidget);
    expect(find.byKey(const Key('send_otp_button')), findsOneWidget);
    expect(find.byKey(const Key('code_field')), findsNothing);
  });

  testWidgets('codeSent callback causes code-entry field to appear',
      (tester) async {
    when(
      () => mockFb.verifyPhoneNumber(
        phoneNumber: any(named: 'phoneNumber'),
        timeout: any(named: 'timeout'),
        verificationCompleted: any(named: 'verificationCompleted'),
        verificationFailed: any(named: 'verificationFailed'),
        codeSent: any(named: 'codeSent'),
        codeAutoRetrievalTimeout: any(named: 'codeAutoRetrievalTimeout'),
      ),
    ).thenAnswer((invocation) {
      final codeSent =
          invocation.namedArguments[#codeSent] as PhoneCodeSent;
      codeSent('fake-verification-id', null);
      return Future<void>.value();
    });

    await tester.pumpWidget(_buildScreen(mockFb));
    await tester.enterText(
      find.byKey(const Key('phone_field')),
      '+12345678901',
    );
    await tester.tap(find.byKey(const Key('send_otp_button')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('code_field')), findsOneWidget);
    expect(find.byKey(const Key('verify_button')), findsOneWidget);
    expect(find.byKey(const Key('phone_field')), findsNothing);
  });

  testWidgets('invalid phone number shows validation error', (tester) async {
    await tester.pumpWidget(_buildScreen(mockFb));
    await tester.enterText(find.byKey(const Key('phone_field')), 'notaphone');
    await tester.tap(find.byKey(const Key('send_otp_button')));
    await tester.pumpAndSettle();

    expect(find.text('Enter a valid E.164 number (e.g. +1234567890)'),
        findsOneWidget);
    expect(find.byKey(const Key('code_field')), findsNothing);
  });
}
