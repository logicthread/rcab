import 'package:dio/dio.dart';

/// Name of the HttpOnly refresh-token cookie the rcab API sets on
/// firebase-exchange / refresh / google-login responses.
const kRefreshCookieName = 'refresh_token';

/// Extracts a cookie value from a response's `Set-Cookie` headers.
///
/// The API delivers the refresh token as an HttpOnly cookie (not in the JSON
/// body — that keeps it out of JS on web). The mobile client has no cookie jar,
/// so it reads the value here and stores it itself for the body-based
/// `POST /v1/auth/refresh` (which accepts `refresh_token` in the body).
String? cookieFromResponse(Response<dynamic> res, String name) {
  final cookies = res.headers.map['set-cookie'];
  if (cookies == null) return null;
  for (final header in cookies) {
    for (final part in header.split(';')) {
      final kv = part.trim();
      final eq = kv.indexOf('=');
      if (eq > 0 && kv.substring(0, eq) == name) {
        return kv.substring(eq + 1);
      }
    }
  }
  return null;
}
