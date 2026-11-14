import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FirebaseAdminService, parseServiceAccountJson } from './firebase-admin.service';
import { defaultPolicy } from '../../config/policy/policy';

const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';

describe('parseServiceAccountJson (F11)', () => {
  it('maps the key-file fields to a ServiceAccount', () => {
    const json = JSON.stringify({
      type: 'service_account',
      project_id: 'rcab-prod',
      client_email: 'svc@rcab-prod.iam.gserviceaccount.com',
      private_key: PRIVATE_KEY,
    });
    expect(parseServiceAccountJson(json)).toEqual({
      projectId: 'rcab-prod',
      clientEmail: 'svc@rcab-prod.iam.gserviceaccount.com',
      privateKey: PRIVATE_KEY,
    });
  });

  it('reports invalid JSON without echoing any of the credential', () => {
    const broken = `{"project_id":"rcab-prod","private_key":"${'MIIEvQIBADANBgkqhkiG9w0'}`; // truncated
    try {
      parseServiceAccountJson(broken);
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toBe('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
      expect(message).not.toContain('MIIEvQ');
      expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it.each([
    ['an array', '[]'],
    ['a string', '"x"'],
    ['null', 'null'],
  ])('rejects %s', (_label, json) => {
    expect(() => parseServiceAccountJson(json)).toThrow(/must be a JSON object/);
  });

  it('names the missing fields only', () => {
    const json = JSON.stringify({ project_id: 'rcab-prod', private_key: PRIVATE_KEY });
    expect(() => parseServiceAccountJson(json)).toThrow(
      'FIREBASE_SERVICE_ACCOUNT_JSON is missing required field(s): client_email',
    );
  });

  it('treats empty strings as missing', () => {
    const json = JSON.stringify({ project_id: '', client_email: '', private_key: '' });
    expect(() => parseServiceAccountJson(json)).toThrow(/project_id, client_email, private_key/);
  });
});

describe('FirebaseAdminService boot behaviour (RCAB-E8.S15)', () => {
  const saved = { project: process.env.FIREBASE_PROJECT_ID, json: process.env.FIREBASE_SERVICE_ACCOUNT_JSON };

  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  });

  afterEach(() => {
    if (saved.project !== undefined) process.env.FIREBASE_PROJECT_ID = saved.project;
    if (saved.json !== undefined) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = saved.json;
  });

  it('boots without Firebase credentials while phone is disabled (Google-only default)', () => {
    expect(() => new FirebaseAdminService(defaultPolicy())).not.toThrow();
  });

  it('a later phone verification still fails loudly on the missing credentials', () => {
    const service = new FirebaseAdminService(defaultPolicy());
    expect(() => service.verifyIdToken('t')).toThrow(/FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be set/);
  });

  it('still fails startup on missing credentials while phone is enabled (F11)', () => {
    expect(() => new FirebaseAdminService(defaultPolicy({ auth: { enabledMethods: ['phone'] } }))).toThrow(
      /must be set/,
    );
  });
});
