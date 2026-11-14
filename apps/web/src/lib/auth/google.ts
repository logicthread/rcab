/**
 * Google Identity Services (GIS) loader. Sign-in uses `google.accounts.id`,
 * which hands the page a Google ID token (a JWT) that the API verifies directly
 * with Google. Firebase is not involved.
 */

export const GSI_SRC = 'https://accounts.google.com/gsi/client';

export interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
}

interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'large' | 'medium' | 'small';
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
      shape?: 'rectangular' | 'pill';
      width?: number;
      logo_alignment?: 'left' | 'center';
    },
  ): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

let loading: Promise<GoogleIdApi> | null = null;

function gsiApi(): GoogleIdApi | undefined {
  return typeof window === 'undefined' ? undefined : window.google?.accounts?.id;
}

/** Load the GIS script once; resolves the `google.accounts.id` API. Rejects (and may be retried) on failure. */
export function loadGsi(): Promise<GoogleIdApi> {
  const ready = gsiApi();
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<GoogleIdApi>((resolve, reject) => {
    const fail = () => {
      loading = null;
      document.querySelector(`script[src="${GSI_SRC}"]`)?.remove();
      reject(new Error('Google Identity Services failed to load'));
    };
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = gsiApi();
      if (api) resolve(api);
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}

// GIS keeps ONE global callback per initialize(). Route it through a mutable
// handler so a re-render (or React Strict Mode's double effect) never leaves a
// stale closure registered, and only call initialize() when the client id changes.
let initializedFor: string | null = null;
let currentHandler: ((r: GoogleCredentialResponse) => void) | null = null;

export function initGoogleSignIn(
  api: GoogleIdApi,
  clientId: string,
  onCredential: (r: GoogleCredentialResponse) => void,
): void {
  currentHandler = onCredential;
  if (initializedFor === clientId) return;
  api.initialize({
    client_id: clientId,
    callback: (r) => currentHandler?.(r),
  });
  initializedFor = clientId;
}

/** Test helper: forget module state between tests. */
export function __resetGoogleStateForTests(): void {
  loading = null;
  initializedFor = null;
  currentHandler = null;
}
