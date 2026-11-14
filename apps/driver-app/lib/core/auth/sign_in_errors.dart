import 'package:dio/dio.dart';

import '../api/api_error.dart';

/// Driver-facing copy for a failed sign-in call. Keyed on the API's error
/// `code` (40-backend/error-codes.md); the status-only fallback is the
/// pre-RCAB-E8.S15 wording.
String signInErrorMessage(DioException e) {
  switch (ApiError.of(e)?.code) {
    case 'google_token_invalid':
      return 'Google sign-in could not be verified. Please try again.';
    case 'google_email_unverified':
      return 'Your Google email is not verified. Verify it with Google, '
          'then try again.';
    case 'google_not_configured':
      return 'Google sign-in is not set up on this server yet. '
          'Contact support.';
    case 'auth_method_disabled':
      return 'This sign-in method is turned off. Use Continue with Google.';
    case 'account_disabled':
      return 'This account has been disabled. Contact support.';
  }
  final status = e.response?.statusCode;
  return status != null ? 'Sign-in failed ($status)' : 'Network error';
}
