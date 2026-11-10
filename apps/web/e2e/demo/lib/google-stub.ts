/**
 * Browser-side stand-in for Google sign-in, for scenes that show the /signin screen (W01, W02, W10).
 *
 * A recording must never talk to Google or need a real OAuth client, and the dev API has no Google client id
 * configured (GET /v1/auth/config -> google.clientId null, so the page would say "not set up"). So, in the
 * RECORDING BROWSER ONLY (Playwright routes; the dev stack and the shipped app are untouched):
 *
 *  - GET  {API}/v1/auth/config           -> { methods: ['google'], google: { clientId: <placeholder> } }
 *  - GET  https://accounts.google.com/gsi/client -> a tiny script defining google.accounts.id. Its
 *        renderButton() draws a "Continue with Google" button where Google's iframe would be; clicking it hands
 *        the page a fake credential, exactly as GIS would after a real account pick.
 *  - POST {API}/v1/auth/google           -> the error the scene asks for (never a success: no session is minted)
 *
 * Everything the page does with those answers (config-driven rendering, the credential POST with
 * credentials:'include', the error copy) is the real shipped code.
 */
import type { Page, Route } from '@playwright/test';
import { API_BASE, WEB_BASE } from './devstack';

export const DEMO_GOOGLE_CLIENT_ID = 'demo-recording.apps.googleusercontent.com';

const GIS_STUB = `
window.google = { accounts: { id: (function () {
  var cfg = null;
  return {
    initialize: function (c) { cfg = c; },
    renderButton: function (parent, o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Continue with Google');
      b.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;height:40px;width:' + (o.width || 280) +
        'px;background:#fff;color:#3c4043;border:1px solid #dadce0;border-radius:4px;font:500 14px Roboto,Arial,sans-serif;cursor:pointer';
      b.innerHTML = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg><span>Continue with Google</span>';
      b.addEventListener('click', function () { if (cfg) cfg.callback({ credential: 'demo-simulated-credential', select_by: 'btn' }); });
      parent.appendChild(b);
    }
  };
})() } };
`;

const CORS = {
  'access-control-allow-origin': WEB_BASE,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  vary: 'Origin',
};

export interface GoogleStub {
  /** The error code the simulated POST /v1/auth/google answers with from now on. */
  setExchangeError(code: string, status: number): void;
}

export async function stubGoogleSignIn(page: Page): Promise<GoogleStub> {
  let exchange = { code: 'google_token_invalid', status: 401 };

  const answer = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route(`${API_BASE}/v1/auth/config`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : answer(route, 200, { methods: ['google'], google: { clientId: DEMO_GOOGLE_CLIENT_ID } }),
  );
  await page.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: GIS_STUB }),
  );
  await page.route(`${API_BASE}/v1/auth/google`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: CORS })
      : answer(route, exchange.status, { error: { code: exchange.code, message: 'simulated for the recording' } }),
  );

  return {
    setExchangeError(code, status) {
      exchange = { code, status };
    },
  };
}
