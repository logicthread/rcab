import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '../../lib/auth/store';
import { __resetGoogleStateForTests, GSI_SRC } from '../../lib/auth/google';

const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock('firebase/auth', () => ({
  signInWithPhoneNumber: vi.fn(),
  RecaptchaVerifier: vi.fn().mockImplementation(() => ({ clear: vi.fn() })),
}));

vi.mock('../../lib/auth/firebase', () => ({
  getFirebaseAuth: vi.fn(() => ({})),
}));

import { signInWithPhoneNumber } from 'firebase/auth';
import { getFirebaseAuth } from '../../lib/auth/firebase';
import SignInPage from './sign-in-client';

type Credential = { credential?: string };

const CLIENT_ID = 'web-client.apps.googleusercontent.com';

const googleOnly = { methods: ['google'], google: { clientId: CLIENT_ID } };

let gisCallback: ((r: Credential) => void) | null = null;
const gisInitialize = vi.fn();
const gisRenderButton = vi.fn();

/** Stand-in for Google Identity Services: renders a button where the real one would. */
function installGis() {
  gisCallback = null;
  window.google = {
    accounts: {
      id: {
        initialize: (cfg: { client_id: string; callback: (r: Credential) => void }) => {
          gisInitialize(cfg);
          gisCallback = cfg.callback;
        },
        renderButton: (parent: HTMLElement, opts: unknown) => {
          gisRenderButton(opts);
          const b = document.createElement('button');
          b.textContent = 'Continue with Google';
          parent.appendChild(b);
        },
      },
    },
  } as never;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

/** fetch stub: GET /auth/config → `config`, every POST → `exchange`. */
function stubFetch(config: unknown, exchange?: Response | Error) {
  const fn = vi.fn((url: string, _init?: RequestInit) => {
    if (String(url).includes('/v1/auth/config')) {
      return config instanceof Error
        ? Promise.reject(config)
        : Promise.resolve(jsonResponse(200, config));
    }
    if (exchange instanceof Error) return Promise.reject(exchange);
    return Promise.resolve(exchange ?? jsonResponse(500, {}));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function exchangeCall(fn: ReturnType<typeof stubFetch>, path: string) {
  return fn.mock.calls.find(([u]) => String(u).includes(path));
}

/** The real (enabled) Google button; waits out the disabled placeholder shown while GIS loads. */
async function googleButton() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled(),
  );
  return screen.getByRole('button', { name: /continue with google/i });
}

async function signInWithCredential(credential: string | undefined) {
  await googleButton();
  gisCallback!({ credential });
}

describe('SignInPage', () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, jwt: null });
    vi.clearAllMocks();
    __resetGoogleStateForTests();
    delete (window as { google?: unknown }).google;
    document.head.querySelectorAll(`script[src="${GSI_SRC}"]`).forEach((s) => s.remove());
    installGis();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to /book when already authenticated', async () => {
    stubFetch(googleOnly);
    useAuthStore.setState({
      user: { id: 'uid', role: 'client', phone_e164: null, email: 'a@gmail.com' },
      jwt: 'some-jwt',
    });
    render(<SignInPage />);
    expect(mockReplace).toHaveBeenCalledWith('/book');
  });

  describe('config-driven rendering', () => {
    it('fetches /v1/auth/config and renders the Google button with the configured client id', async () => {
      const fetchFn = stubFetch(googleOnly);
      render(<SignInPage />);

      expect(await googleButton()).toBeInTheDocument();
      expect(String(fetchFn.mock.calls[0][0])).toContain('/v1/auth/config');
      expect(gisInitialize).toHaveBeenCalledWith(expect.objectContaining({ client_id: CLIENT_ID }));
      expect(gisRenderButton).toHaveBeenCalledWith(expect.objectContaining({ text: 'continue_with' }));
    });

    it('hides the phone OTP UI when only google is enabled', async () => {
      stubFetch(googleOnly);
      render(<SignInPage />);
      await googleButton();

      expect(screen.queryByLabelText(/phone number/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /send otp/i })).not.toBeInTheDocument();
      // Firebase is never initialised while phone is off.
      expect(getFirebaseAuth).not.toHaveBeenCalled();
    });

    it('shows the phone UI (and no Google button) when only phone is enabled', async () => {
      stubFetch({ methods: ['phone'], google: { clientId: null } });
      render(<SignInPage />);

      expect(await screen.findByLabelText(/phone number/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send otp/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();
    });

    it('shows both methods when both are enabled', async () => {
      stubFetch({ methods: ['google', 'phone'], google: { clientId: CLIENT_ID } });
      render(<SignInPage />);

      expect(await googleButton()).toBeInTheDocument();
      expect(await screen.findByLabelText(/phone number/i)).toBeInTheDocument();
    });

    it('ignores unknown methods in the config', async () => {
      stubFetch({ methods: ['google', 'carrier-pigeon'], google: { clientId: CLIENT_ID } });
      render(<SignInPage />);
      expect(await googleButton()).toBeInTheDocument();
      expect(screen.queryByText(/pigeon/i)).not.toBeInTheDocument();
    });

    it('falls back to NEXT_PUBLIC_GOOGLE_CLIENT_ID when the API sends no client id', async () => {
      vi.stubEnv('NEXT_PUBLIC_GOOGLE_CLIENT_ID', 'fallback.apps.googleusercontent.com');
      stubFetch({ methods: ['google'], google: { clientId: null } });
      render(<SignInPage />);

      await googleButton();
      expect(gisInitialize).toHaveBeenCalledWith(
        expect.objectContaining({ client_id: 'fallback.apps.googleusercontent.com' }),
      );
      vi.unstubAllEnvs();
    });

    it('says Google sign-in is not set up when no client id is available anywhere', async () => {
      stubFetch({ methods: ['google'], google: { clientId: null } });
      render(<SignInPage />);

      expect(await screen.findByRole('alert')).toHaveTextContent(/not set up on this server/i);
      expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();
      expect(gisInitialize).not.toHaveBeenCalled();
    });

    it('offers a retry when the config cannot be loaded', async () => {
      const ue = userEvent.setup();
      const fetchFn = stubFetch(new Error('offline'));
      render(<SignInPage />);

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not load sign-in options/i);
      expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();

      fetchFn.mockImplementation(() => Promise.resolve(jsonResponse(200, googleOnly)));
      await ue.click(screen.getByRole('button', { name: /try again/i }));
      expect(await googleButton()).toBeInTheDocument();
    });

    it('shows an error with retry when the Google script fails to load', async () => {
      delete (window as { google?: unknown }).google;
      stubFetch(googleOnly);
      render(<SignInPage />);

      await waitFor(() =>
        expect(document.head.querySelector(`script[src="${GSI_SRC}"]`)).not.toBeNull(),
      );
      document.head.querySelector(`script[src="${GSI_SRC}"]`)!.dispatchEvent(new Event('error'));

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not load google sign-in/i);
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });
  });

  describe('Google sign-in', () => {
    it('posts the credential to /v1/auth/google (with cookies), stores the session and redirects', async () => {
      const fetchFn = stubFetch(
        googleOnly,
        jsonResponse(200, {
          access_token: 'rcab-jwt',
          token_type: 'Bearer',
          expires_in: 900,
          user: { id: 'uid', role: 'client', phone_e164: null, email: 'rider@gmail.com' },
        }),
      );
      render(<SignInPage />);
      await signInWithCredential('google-id-token');

      await waitFor(() => expect(useAuthStore.getState().jwt).toBe('rcab-jwt'));
      const [url, init] = exchangeCall(fetchFn, '/v1/auth/google')!;
      expect(String(url)).toMatch(/\/v1\/auth\/google$/);
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ id_token: 'google-id-token' }),
      });
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
      expect(useAuthStore.getState().user).toMatchObject({ email: 'rider@gmail.com', phone_e164: null });
      expect(mockReplace).toHaveBeenCalledWith('/book');
    });

    it.each([
      ['google_email_unverified', 403, /email is not verified/i],
      ['auth_method_disabled', 403, /not available right now/i],
      ['account_disabled', 403, /account has been disabled/i],
      ['google_not_configured', 503, /not set up on this server/i],
      ['google_token_invalid', 401, /could not be verified/i],
    ])('shows clear copy for %s and does not sign in', async (code, status, copy) => {
      stubFetch(googleOnly, jsonResponse(status, { error: { code, message: 'x' } }));
      render(<SignInPage />);
      await signInWithCredential('google-id-token');

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(copy);
      expect(useAuthStore.getState().jwt).toBeNull();
      expect(mockReplace).not.toHaveBeenCalledWith('/book');
    });

    it('shows a generic message for an unknown error code', async () => {
      stubFetch(googleOnly, jsonResponse(500, { error: { code: 'internal_error' } }));
      render(<SignInPage />);
      await signInWithCredential('google-id-token');
      expect(await screen.findByRole('alert')).toHaveTextContent(/sign-in failed/i);
    });

    it('shows a network message when the exchange request cannot be sent', async () => {
      stubFetch(googleOnly, new TypeError('Failed to fetch'));
      render(<SignInPage />);
      await signInWithCredential('google-id-token');
      expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the server/i);
      expect(mockReplace).not.toHaveBeenCalledWith('/book');
    });

    it('does not call the API when Google returns no credential', async () => {
      const fetchFn = stubFetch(googleOnly);
      render(<SignInPage />);
      await signInWithCredential(undefined);

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not be verified/i);
      expect(exchangeCall(fetchFn, '/v1/auth/google')).toBeUndefined();
    });

    it('lets the user retry after an error', async () => {
      const fetchFn = stubFetch(
        googleOnly,
        jsonResponse(403, { error: { code: 'google_email_unverified' } }),
      );
      render(<SignInPage />);
      await signInWithCredential('t1');
      await screen.findByRole('alert');

      fetchFn.mockImplementation((url: string, _init?: RequestInit) =>
        Promise.resolve(
          String(url).includes('/v1/auth/config')
            ? jsonResponse(200, googleOnly)
            : jsonResponse(200, {
                access_token: 'jwt2',
                user: { id: 'u', role: 'client', phone_e164: null, email: 'a@b.c' },
              }),
        ),
      );
      gisCallback!({ credential: 't2' });

      await waitFor(() => expect(useAuthStore.getState().jwt).toBe('jwt2'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('phone OTP (disabled by default, behind the flag)', () => {
    async function openPhoneStep(ue: ReturnType<typeof userEvent.setup>) {
      await ue.type(await screen.findByLabelText(/phone number/i), '+12025551234');
      await ue.click(screen.getByRole('button', { name: /send otp/i }));
    }

    it('exchanges the Firebase token at firebase-exchange and redirects', async () => {
      const ue = userEvent.setup();
      const mockConfirm = vi.fn().mockResolvedValue({
        user: { getIdToken: vi.fn().mockResolvedValue('firebase-id-token') },
      });
      vi.mocked(signInWithPhoneNumber).mockResolvedValue({ confirm: mockConfirm } as never);
      const fetchFn = stubFetch(
        { methods: ['phone'], google: { clientId: null } },
        jsonResponse(200, {
          access_token: 'rcab-jwt',
          user: { id: 'uid', role: 'client', phone_e164: '+12025551234' },
        }),
      );

      render(<SignInPage />);
      await openPhoneStep(ue);
      expect(signInWithPhoneNumber).toHaveBeenCalledWith(
        expect.anything(),
        '+12025551234',
        expect.anything(),
      );
      await ue.type(await screen.findByLabelText(/6-digit otp/i), '123456');
      await ue.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/book'));
      const [, init] = exchangeCall(fetchFn, '/v1/auth/firebase-exchange')!;
      expect(init).toMatchObject({ body: JSON.stringify({ id_token: 'firebase-id-token' }) });
      expect(useAuthStore.getState().jwt).toBe('rcab-jwt');
    });

    it('shows an error on incorrect OTP without redirecting', async () => {
      const ue = userEvent.setup();
      const mockConfirm = vi.fn().mockRejectedValue(new Error('auth/invalid-verification-code'));
      vi.mocked(signInWithPhoneNumber).mockResolvedValue({ confirm: mockConfirm } as never);
      stubFetch({ methods: ['phone'], google: { clientId: null } });

      render(<SignInPage />);
      await openPhoneStep(ue);
      await ue.type(await screen.findByLabelText(/6-digit otp/i), '999999');
      await ue.click(screen.getByRole('button', { name: /verify/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('auth/invalid-verification-code');
      expect(mockReplace).not.toHaveBeenCalledWith('/book');
    });

    it('maps auth_method_disabled from firebase-exchange to the same clear copy', async () => {
      const ue = userEvent.setup();
      const mockConfirm = vi.fn().mockResolvedValue({
        user: { getIdToken: vi.fn().mockResolvedValue('t') },
      });
      vi.mocked(signInWithPhoneNumber).mockResolvedValue({ confirm: mockConfirm } as never);
      stubFetch(
        { methods: ['phone'], google: { clientId: null } },
        jsonResponse(403, { error: { code: 'auth_method_disabled' } }),
      );

      render(<SignInPage />);
      await openPhoneStep(ue);
      await ue.type(await screen.findByLabelText(/6-digit otp/i), '123456');
      await ue.click(screen.getByRole('button', { name: /verify/i }));

      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(/not available right now/i)).toBeInTheDocument();
    });
  });
});
