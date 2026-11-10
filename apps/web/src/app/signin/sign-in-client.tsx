'use client';

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore, type AuthUser } from '../../lib/auth/store';
import {
  fetchAuthConfig,
  resolveGoogleClientId,
  type AuthConfig,
} from '../../lib/auth/config';
import {
  NETWORK_ERROR_MESSAGE,
  readErrorCode,
  signInErrorMessage,
} from '../../lib/auth/auth-errors';
import {
  initGoogleSignIn,
  loadGsi,
  type GoogleCredentialResponse,
} from '../../lib/auth/google';

// Phone OTP (Firebase) is DISABLED until the pre-launch OTP provider lands
// (policy auth.enabledMethods, RCAB-E8.S15). Its code stays, but it is a lazy
// chunk that is only fetched, and Firebase only initialised, when the API's
// /v1/auth/config lists 'phone'.
const PhoneSignIn = lazy(() => import('./phone-sign-in'));

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

type ConfigState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; config: AuthConfig };

type GoogleState = 'idle' | 'loading' | 'ready' | 'failed';

export default function SignInPage() {
  const router = useRouter();
  const { user, setAuth } = useAuthStore();

  const [cfg, setCfg] = useState<ConfigState>({ status: 'loading' });
  const [cfgAttempt, setCfgAttempt] = useState(0);
  const [googleState, setGoogleState] = useState<GoogleState>('idle');
  const [gsiAttempt, setGsiAttempt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const googleButtonRef = useRef<HTMLDivElement>(null);

  // Already authenticated: skip straight to /book
  useEffect(() => {
    if (user) router.replace('/book');
  }, [user, router]);

  // Which methods are on is the API's call (policy auth.enabledMethods).
  useEffect(() => {
    const ctl = new AbortController();
    setCfg({ status: 'loading' });
    fetchAuthConfig(ctl.signal).then(
      (config) => setCfg({ status: 'ready', config }),
      () => {
        if (!ctl.signal.aborted) setCfg({ status: 'error' });
      },
    );
    return () => ctl.abort();
  }, [cfgAttempt]);

  const config = cfg.status === 'ready' ? cfg.config : null;
  const googleEnabled = config?.methods.includes('google') ?? false;
  const phoneEnabled = config?.methods.includes('phone') ?? false;
  const googleClientId = config ? resolveGoogleClientId(config) : null;

  /** POST an identity-provider token to the API and continue into the app. */
  const exchange = useCallback(
    async (path: string, idToken: string) => {
      setError('');
      setBusy(true);
      try {
        const res = await fetch(`${API_BASE}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The refresh token comes back as an HttpOnly cookie. CsrfGuard is
          // Origin-based: the browser attaches Origin itself, no extra header.
          credentials: 'include',
          body: JSON.stringify({ id_token: idToken }),
        });
        if (!res.ok) {
          setError(signInErrorMessage(await readErrorCode(res)));
          return;
        }
        const data = (await res.json()) as { access_token: string; user: AuthUser };
        setAuth(data.user, data.access_token);
        router.replace('/book');
      } catch {
        setError(NETWORK_ERROR_MESSAGE);
      } finally {
        setBusy(false);
      }
    },
    [router, setAuth],
  );

  // GIS keeps one global callback; route it to the latest closure.
  const onGoogleCredential = useRef<(r: GoogleCredentialResponse) => void>(() => {});
  onGoogleCredential.current = (r) => {
    if (!r.credential) {
      setError(signInErrorMessage('google_token_invalid'));
      return;
    }
    void exchange('/v1/auth/google', r.credential);
  };

  // Load Google Identity Services and render its button.
  useEffect(() => {
    if (!googleEnabled || !googleClientId) {
      setGoogleState('idle');
      return;
    }
    let cancelled = false;
    setGoogleState('loading');
    loadGsi().then(
      (api) => {
        if (cancelled || !googleButtonRef.current) return;
        initGoogleSignIn(api, googleClientId, (r) => onGoogleCredential.current(r));
        googleButtonRef.current.replaceChildren();
        api.renderButton(googleButtonRef.current, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: 280,
        });
        setGoogleState('ready');
      },
      () => {
        if (!cancelled) setGoogleState('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [googleEnabled, googleClientId, gsiAttempt]);

  return (
    <main style={{ maxWidth: 360, margin: '0 auto', padding: 16 }}>
      <h1>Sign in</h1>

      {cfg.status === 'loading' && <p role="status">Loading sign-in options…</p>}

      {cfg.status === 'error' && (
        <div role="alert">
          <p>Could not load sign-in options. Check your connection and try again.</p>
          <button type="button" onClick={() => setCfgAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {config && config.methods.length === 0 && (
        <p role="alert">Sign-in is not available right now.</p>
      )}

      {googleEnabled && (
        <section aria-label="Google sign-in" aria-busy={busy}>
          <p style={{ fontSize: 14, color: '#525252' }}>
            Sign in with your Google account. New here? An account is created the first time you
            sign in.
          </p>

          {googleClientId === null && (
            <p role="alert">{signInErrorMessage('google_not_configured')}</p>
          )}

          {googleClientId !== null && (
            <div style={{ opacity: busy ? 0.5 : 1, pointerEvents: busy ? 'none' : 'auto' }}>
              {googleState === 'loading' && (
                <button type="button" disabled style={{ width: 280, padding: '10px 12px' }}>
                  Continue with Google
                </button>
              )}
              {/* Google renders its own "Continue with Google" button here. */}
              <div ref={googleButtonRef} data-testid="google-signin-button" />
            </div>
          )}

          {googleState === 'failed' && (
            <div role="alert">
              <p>
                Could not load Google sign-in. Check your connection (or any content blocker) and
                try again.
              </p>
              <button type="button" onClick={() => setGsiAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          )}

          {busy && <p role="status">Signing you in…</p>}
        </section>
      )}

      {phoneEnabled && (
        <Suspense fallback={<p role="status">Loading…</p>}>
          <PhoneSignIn
            busy={busy}
            onError={setError}
            onIdToken={(token) => exchange('/v1/auth/firebase-exchange', token)}
          />
        </Suspense>
      )}

      {error && (
        <p role="alert" style={{ color: '#b91c1c' }}>
          {error}
        </p>
      )}
    </main>
  );
}
