import { Inject, Injectable, Optional } from '@nestjs/common';
import { POLICY, getPolicy } from '../../config/policy/policy';
import type { Policy } from '../../config/policy/policy.schema';
import * as admin from 'firebase-admin';

const REQUIRED_SERVICE_ACCOUNT_FIELDS = ['project_id', 'client_email', 'private_key'] as const;

/**
 * Parses FIREBASE_SERVICE_ACCOUNT_JSON (the service-account key file's JSON on
 * one line). Errors name the variable and missing field only — never echo the
 * input, since `JSON.parse` messages can quote fragments of the private key.
 */
export function parseServiceAccountJson(json: string): admin.ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const missing = REQUIRED_SERVICE_ACCOUNT_FIELDS.filter(
    (field) => typeof record[field] !== 'string' || record[field] === '',
  );
  if (missing.length > 0) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is missing required field(s): ${missing.join(', ')}`);
  }
  return {
    projectId: record.project_id as string,
    clientEmail: record.client_email as string,
    privateKey: record.private_key as string,
  };
}

/**
 * Firebase Admin — verifies phone-OTP ID tokens for the `phone` sign-in
 * method. While `phone` is enabled (policy `auth.enabledMethods`) missing
 * credentials fail startup (F11). While it is disabled (Google-only until
 * launch, RCAB-E8.S15) nothing is initialised at boot, so a deployment needs no
 * Firebase credentials; the exchange is refused upstream with
 * `auth_method_disabled` before this provider is reached.
 */
@Injectable()
export class FirebaseAdminService {
  private auth: admin.auth.Auth | null = null;

  constructor(@Optional() @Inject(POLICY) policy: Policy = getPolicy()) {
    if (policy.auth.enabledMethods.includes('phone')) this.auth = initFirebaseAuth();
  }

  verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    this.auth ??= initFirebaseAuth();
    return this.auth.verifyIdToken(idToken);
  }
}

function initFirebaseAuth(): admin.auth.Auth {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (admin.apps.length === 0) {
    if (!projectId || !serviceAccountJson) {
      throw new Error('FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be set');
    }
    const serviceAccount = parseServiceAccountJson(serviceAccountJson);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId });
  }
  return admin.app().auth();
}
