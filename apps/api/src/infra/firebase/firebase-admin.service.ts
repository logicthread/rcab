import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';

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
      const serviceAccount = JSON.parse(serviceAccountJson) as admin.ServiceAccount;
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId });
    }

    this.auth = admin.app().auth();
  }

  verifyIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
    return this.auth.verifyIdToken(idToken);
  }
}
