/** User-facing copy for the API's sign-in error codes (40-backend/error-codes.md). */

const COPY: Record<string, string> = {
  google_token_invalid: 'Google sign-in could not be verified (it may have expired). Please try again.',
  google_email_unverified:
    'Your Google account email is not verified. Verify it with Google, then sign in again.',
  google_not_configured: 'Google sign-in is not set up on this server yet. Please try again later.',
  auth_method_disabled: 'This sign-in method is not available right now.',
  account_disabled: 'This account has been disabled. Contact support if you think this is a mistake.',
  csrf_rejected: 'Sign-in was blocked for security reasons. Reload the page and try again.',
};

const GENERIC = 'Sign-in failed. Please try again.';
const NETWORK = 'Could not reach the server. Check your connection and try again.';

/** Pull `error.code` from the API's `{ error: { code, message } }` body; null if absent. */
export async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}

export function signInErrorMessage(code: string | null): string {
  return (code && COPY[code]) || GENERIC;
}

export const NETWORK_ERROR_MESSAGE = NETWORK;
