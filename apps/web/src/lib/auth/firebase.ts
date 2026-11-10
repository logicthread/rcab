import { initializeApp, getApps } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

/**
 * Firebase (phone OTP) is only initialised when phone sign-in is enabled
 * (policy `auth.enabledMethods` includes 'phone'; RCAB-E8.S15). It is created
 * lazily, so a build or a page that does not use phone auth never needs the
 * NEXT_PUBLIC_FIREBASE_* values. Only the phone sign-in component imports this.
 *
 * Before launch the OTP provider may change and Firebase may go away; this and
 * `phone-sign-in.tsx` are the only places that know about it.
 */
let auth: Auth | null = null;

export function getFirebaseAuth(): Auth {
  if (auth) return auth;
  const app =
    getApps().length === 0
      ? initializeApp({
          apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
          authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
          projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
          appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
        })
      : getApps()[0];
  auth = getAuth(app);
  return auth;
}
