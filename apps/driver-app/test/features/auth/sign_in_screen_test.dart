import 'package:dio/dio.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:mocktail/mocktail.dart';

import 'package:driver_app/core/auth/auth_config.dart';
import 'package:driver_app/core/auth/auth_notifier.dart';
import 'package:driver_app/core/auth/auth_state.dart';
import 'package:driver_app/core/auth/token_store.dart';
import 'package:driver_app/di/providers.dart';
import 'package:driver_app/features/auth/sign_in_screen.dart';

// ---------------------------------------------------------------------------
// Fakes & mocks
// ---------------------------------------------------------------------------

class MockFirebaseAuth extends Mock implements FirebaseAuth {}

class MockDio extends Mock implements Dio {}

class MockGoogleSignIn extends Mock implements GoogleSignIn {}

class MockGoogleSignInAccount extends Mock implements GoogleSignInAccount {}

class MockGoogleSignInAuthentication extends Mock
    implements GoogleSignInAuthentication {}

class _FakeTokenStore extends TokenStore {
  final Map<String, String> _data = {};

  @override
  Future<void> saveTokens(
      {required String jwt, required String refresh}) async {
    _data['rcab_jwt'] = jwt;
    _data['rcab_refresh_token'] = refresh;
  }

  @override
  Future<void> saveAccount({String? email, String? phoneE164}) async {}

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

const _phoneOnly = AuthConfig(methods: {'phone'});
const _googleOnly =
    AuthConfig(methods: {'google'}, googleClientId: 'web-client.apps.test');

/// [config] null makes `GET /v1/auth/config` fail.
Widget _buildScreen(
  MockFirebaseAuth mockFb, {
  AuthConfig? config = _phoneOnly,
  Dio? dio,
  GoogleSignInFactory? google,
}) {
  final store = _FakeTokenStore();
  return ProviderScope(
    overrides: [
      tokenStoreProvider.overrideWithValue(store),
      firebaseAuthProvider.overrideWithValue(mockFb),
      authConfigProvider.overrideWith((ref) async {
        if (config == null) throw Exception('offline');
        return config;
      }),
      authProvider.overrideWith(
        (ref) => AuthNotifier(
          store,
          mockFb,
          dio ?? Dio(),
          googleSignInFactory: google ?? defaultGoogleSignInFactory,
        ),
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
    await tester.pumpAndSettle();

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
      final codeSent = invocation.namedArguments[#codeSent] as PhoneCodeSent;
      codeSent('fake-verification-id', null);
      return Future<void>.value();
    });

    await tester.pumpWidget(_buildScreen(mockFb));
    await tester.pumpAndSettle();
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
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('phone_field')), 'notaphone');
    await tester.tap(find.byKey(const Key('send_otp_button')));
    await tester.pumpAndSettle();

    expect(find.text('Enter a valid E.164 number (e.g. +1234567890)'),
        findsOneWidget);
    expect(find.byKey(const Key('code_field')), findsNothing);
  });

  // RCAB-E8.S14 (seen recording D01): after a rejected Send OTP, the
  // "Enter a valid E.164 number" error stayed under a corrected number until
  // the next tap.
  testWidgets('the phone error clears once the number is corrected',
      (tester) async {
    await tester.pumpWidget(_buildScreen(mockFb));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('phone_field')), '98300 70001');
    await tester.tap(find.byKey(const Key('send_otp_button')));
    await tester.pumpAndSettle();
    expect(find.text('Enter a valid E.164 number (e.g. +1234567890)'),
        findsOneWidget);

    await tester.enterText(
        find.byKey(const Key('phone_field')), '+919830070001');
    await tester.pump();

    expect(find.text('Enter a valid E.164 number (e.g. +1234567890)'),
        findsNothing);
  });

  group('config-driven methods (RCAB-E8.S15)', () {
    testWidgets('google only: Continue with Google, no phone UI',
        (tester) async {
      await tester.pumpWidget(_buildScreen(mockFb, config: _googleOnly));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.byKey(const Key('phone_field')), findsNothing);
      expect(find.byKey(const Key('send_otp_button')), findsNothing);
    });

    testWidgets('phone only: OTP UI, no Google button', (tester) async {
      await tester.pumpWidget(_buildScreen(mockFb, config: _phoneOnly));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('google_sign_in_button')), findsNothing);
      expect(find.byKey(const Key('phone_field')), findsOneWidget);
    });

    testWidgets('both enabled: both are shown', (tester) async {
      await tester.pumpWidget(_buildScreen(
        mockFb,
        config: const AuthConfig(methods: {'google', 'phone'}),
      ));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
      expect(find.byKey(const Key('phone_field')), findsOneWidget);
    });

    testWidgets('no methods: says sign-in is unavailable', (tester) async {
      await tester.pumpWidget(
          _buildScreen(mockFb, config: const AuthConfig(methods: {})));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('no_methods')), findsOneWidget);
      expect(find.byKey(const Key('google_sign_in_button')), findsNothing);
    });

    testWidgets('config unreachable: error with Retry that refetches',
        (tester) async {
      await tester.pumpWidget(_buildScreen(mockFb, config: null));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('config_error')), findsOneWidget);
      expect(find.byKey(const Key('google_sign_in_button')), findsNothing);
      expect(find.byKey(const Key('phone_field')), findsNothing);
      expect(find.byKey(const Key('config_retry')), findsOneWidget);
    });
  });

  group('Continue with Google', () {
    late MockGoogleSignIn gs;
    late MockGoogleSignInAccount account;
    late MockGoogleSignInAuthentication gAuth;
    late MockDio dio;
    String? factoryClientId;

    setUp(() {
      gs = MockGoogleSignIn();
      account = MockGoogleSignInAccount();
      gAuth = MockGoogleSignInAuthentication();
      dio = MockDio();
      factoryClientId = null;
      when(() => gs.signOut()).thenAnswer((_) async => null);
      when(() => account.authentication).thenAnswer((_) async => gAuth);
      when(() => gAuth.idToken).thenReturn('google.id.token');
    });

    Widget screen() => _buildScreen(
          mockFb,
          config: _googleOnly,
          dio: dio,
          google: (id) {
            factoryClientId = id;
            return gs;
          },
        );

    testWidgets('uses the config client id and posts the ID token',
        (tester) async {
      when(() => gs.signIn()).thenAnswer((_) async => account);
      when(() =>
              dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')))
          .thenAnswer((_) async => Response<Map<String, dynamic>>(
                data: {
                  'access_token': 'a',
                  'refresh_token': 'r',
                  'user': {
                    'id': 'u1',
                    'role': 'driver',
                    'phone_e164': null,
                    'email': 'me@example.com',
                  },
                },
                statusCode: 200,
                requestOptions: RequestOptions(path: ''),
              ));
      await tester.pumpWidget(screen());
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('google_sign_in_button')));
      await tester.pumpAndSettle();

      expect(factoryClientId, 'web-client.apps.test');
      verify(() => dio.post<Map<String, dynamic>>(
            '/v1/auth/native/google',
            data: {'id_token': 'google.id.token'},
          )).called(1);
      final container = ProviderScope.containerOf(
          tester.element(find.byKey(const Key('sign_in_screen'))));
      final state = container.read(authProvider) as AuthStateAuthenticated;
      expect(state.email, 'me@example.com');
      expect(state.phoneE164, isNull);
    });

    testWidgets('dismissing the account picker shows no error', (tester) async {
      when(() => gs.signIn()).thenAnswer((_) async => null);
      await tester.pumpWidget(screen());
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('google_sign_in_button')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('error_message')), findsNothing);
      expect(find.byKey(const Key('google_sign_in_button')), findsOneWidget);
      verifyNever(() =>
          dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')));
    });

    for (final c in const {
      'google_token_invalid': 'could not be verified',
      'google_email_unverified': 'not verified',
      'google_not_configured': 'not set up on this server',
      'auth_method_disabled': 'turned off',
      'account_disabled': 'disabled',
    }.entries) {
      testWidgets('${c.key} shows clear copy', (tester) async {
        when(() => gs.signIn()).thenAnswer((_) async => account);
        when(() =>
                dio.post<Map<String, dynamic>>(any(), data: any(named: 'data')))
            .thenThrow(DioException(
          requestOptions: RequestOptions(path: ''),
          type: DioExceptionType.badResponse,
          response: Response(
            statusCode: 403,
            data: {
              'error': {'code': c.key, 'message': 'x', 'request_id': 'r'},
            },
            requestOptions: RequestOptions(path: ''),
          ),
        ));
        await tester.pumpWidget(screen());
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const Key('google_sign_in_button')));
        await tester.pumpAndSettle();

        final text =
            tester.widget<Text>(find.byKey(const Key('error_message'))).data!;
        expect(text, contains(c.value));
        // The button is usable again after a failure.
        expect(
          tester
              .widget<FilledButton>(
                  find.byKey(const Key('google_sign_in_button')))
              .onPressed,
          isNotNull,
        );
      });
    }
  });
}
