import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/auth/auth_config.dart';
import '../../core/config/policy.dart';
import '../../di/providers.dart';

class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  final _phoneController = TextEditingController();
  final _codeController = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  String? _verificationId;
  bool _isLoading = false;
  bool _googleBusy = false;
  String? _errorMessage;

  /// Off until a Send OTP is rejected; then each edit re-validates, so the
  /// error clears as soon as the number is corrected (RCAB-E8.S14).
  AutovalidateMode _autovalidate = AutovalidateMode.disabled;

  bool get _isCodeStep => _verificationId != null;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  /// Continue with Google (RCAB-E8.S15). The router leaves this screen as
  /// soon as the notifier flips to authenticated.
  Future<void> _signInWithGoogle(AuthConfig config) async {
    setState(() {
      _isLoading = true;
      _googleBusy = true;
      _errorMessage = null;
    });
    final clientId = config.googleClientId ??
        (kGoogleServerClientIdFallback.isEmpty
            ? null
            : kGoogleServerClientIdFallback);
    final error = await ref
        .read(authProvider.notifier)
        .signInWithGoogle(serverClientId: clientId);
    if (!mounted) return;
    setState(() {
      _isLoading = false;
      _googleBusy = false;
      _errorMessage = error;
    });
  }

  Future<void> _sendOtp() async {
    if (!_formKey.currentState!.validate()) {
      setState(() => _autovalidate = AutovalidateMode.onUserInteraction);
      return;
    }
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });

    await ref.read(firebaseAuthProvider).verifyPhoneNumber(
      phoneNumber: _phoneController.text.trim(),
      timeout: DriverPolicy.otpAutoRetrievalTimeout,
      verificationCompleted: (PhoneAuthCredential credential) async {
        await _signInWithCredential(credential);
      },
      verificationFailed: (FirebaseAuthException e) {
        if (!mounted) return;
        setState(() {
          _isLoading = false;
          _errorMessage = e.message ?? 'Verification failed';
        });
      },
      codeSent: (String verificationId, int? resendToken) {
        if (!mounted) return;
        setState(() {
          _isLoading = false;
          _verificationId = verificationId;
        });
      },
      codeAutoRetrievalTimeout: (_) {},
    );
  }

  Future<void> _verifyCode() async {
    final vid = _verificationId;
    if (vid == null) return;
    final code = _codeController.text.trim();
    if (code.length != 6) {
      setState(() => _errorMessage = 'Enter the 6-digit code');
      return;
    }
    setState(() {
      _isLoading = true;
      _errorMessage = null;
    });
    final credential = PhoneAuthProvider.credential(
      verificationId: vid,
      smsCode: code,
    );
    await _signInWithCredential(credential);
  }

  Future<void> _signInWithCredential(PhoneAuthCredential credential) async {
    try {
      final auth = ref.read(firebaseAuthProvider);
      final userCredential = await auth.signInWithCredential(credential);
      final idToken = await userCredential.user!.getIdToken();
      final error = await ref
          .read(authProvider.notifier)
          .signInWithFirebaseToken(idToken!);
      if (error != null && mounted) {
        setState(() {
          _isLoading = false;
          _errorMessage = error;
        });
      }
    } on FirebaseAuthException {
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _errorMessage = 'Invalid or expired code';
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _errorMessage = 'Sign-in failed. Try again.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = ref.watch(authConfigProvider);
    return Scaffold(
      key: const Key('sign_in_screen'),
      appBar: AppBar(title: const Text('Sign In')),
      // Scrollable so the form never overflows when the keyboard shrinks the
      // viewport (was a RenderFlex overflow on small heights).
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: config.when(
          loading: () => const Padding(
            padding: EdgeInsets.only(top: 64),
            child: Center(
              child: CircularProgressIndicator(key: Key('config_loading')),
            ),
          ),
          error: (_, __) => _configError(context),
          data: (c) => _methods(context, c),
        ),
      ),
    );
  }

  /// `GET /v1/auth/config` failed: no way to know which methods are on, so
  /// say so and let the driver retry instead of guessing.
  Widget _configError(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          "Can't reach the server. Check your connection and try again.",
          key: const Key('config_error'),
          style: TextStyle(color: Theme.of(context).colorScheme.error),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          key: const Key('config_retry'),
          onPressed: () => ref.invalidate(authConfigProvider),
          child: const Text('Retry'),
        ),
      ],
    );
  }

  /// Renders only the methods the API reports as enabled.
  Widget _methods(BuildContext context, AuthConfig config) {
    final showGoogle = config.googleEnabled;
    final showPhone = config.phoneEnabled;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (showGoogle) _googleButton(config),
        if (showGoogle && showPhone) ...[
          const SizedBox(height: 16),
          const Text('or', textAlign: TextAlign.center),
          const SizedBox(height: 16),
        ],
        if (showPhone) _phoneForm(),
        if (!showGoogle && !showPhone)
          Text(
            'Sign-in is unavailable right now. Please try again later.',
            key: const Key('no_methods'),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
            textAlign: TextAlign.center,
          ),
        if (_errorMessage != null) ...[
          const SizedBox(height: 16),
          Text(
            _errorMessage!,
            key: const Key('error_message'),
            style: TextStyle(
              color: Theme.of(context).colorScheme.error,
            ),
            textAlign: TextAlign.center,
          ),
        ],
      ],
    );
  }

  Widget _googleButton(AuthConfig config) {
    return FilledButton.icon(
      key: const Key('google_sign_in_button'),
      onPressed: _isLoading ? null : () => _signInWithGoogle(config),
      icon: _googleBusy
          ? const SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : const Icon(Icons.account_circle_outlined),
      label: const Text('Continue with Google'),
    );
  }

  /// The phone/OTP UI. Kept intact behind `auth.enabledMethods` so the
  /// future OTP provider only has to re-enable it (ADR-0003 amendment).
  Widget _phoneForm() {
    return Form(
      key: _formKey,
      autovalidateMode: _autovalidate,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (!_isCodeStep) ...[
            TextFormField(
              key: const Key('phone_field'),
              controller: _phoneController,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(
                labelText: 'Phone number',
                hintText: '+1234567890',
              ),
              validator: (v) {
                if (v == null || v.trim().isEmpty) {
                  return 'Enter your phone number';
                }
                if (!RegExp(r'^\+[1-9]\d{6,14}$').hasMatch(v.trim())) {
                  return 'Enter a valid E.164 number (e.g. +1234567890)';
                }
                return null;
              },
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              key: const Key('send_otp_button'),
              onPressed: _isLoading ? null : _sendOtp,
              child: _isLoading && !_googleBusy
                  ? const SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Send OTP'),
            ),
          ] else ...[
            TextFormField(
              key: const Key('code_field'),
              controller: _codeController,
              keyboardType: TextInputType.number,
              maxLength: 6,
              decoration: const InputDecoration(
                labelText: 'SMS code',
                hintText: '123456',
              ),
            ),
            const SizedBox(height: 24),
            ElevatedButton(
              key: const Key('verify_button'),
              onPressed: _isLoading ? null : _verifyCode,
              child: _isLoading && !_googleBusy
                  ? const SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Verify'),
            ),
          ],
        ],
      ),
    );
  }
}
