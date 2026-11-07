import { Injectable } from '@nestjs/common';
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

@Injectable()
export class FirebaseAdminService {
  private readonly auth: admin.auth.Auth;

  constructor() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (admin.apps.length === 0) {
      if (!projectId || !serviceAccountJson) {
        throw new Error('FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be set');
      }
      const serviceAccount = parseServiceAccountJson(serviceAccountJson);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId });
    }

    this.auth = admin.app().auth();
  }

  verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    return this.auth.verifyIdToken(idToken);
  }
}
