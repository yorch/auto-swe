import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };

const delegates = vi.hoisted(() => {
  const make = () => ({
    findMany: vi.fn(async (_a: unknown): Promise<Row[]> => []),
    updateMany: vi.fn(async (_a: unknown) => ({ count: 1 })),
  });
  return {
    connection: make(),
    figmaConfig: make(),
    gitHubConfig: make(),
    googleOAuthConfig: make(),
    issueTrackerConfig: make(),
    knowledgeBaseConfig: make(),
    oktaOAuthConfig: make(),
    providerCredential: make(),
    slackConfig: make(),
    slackWorkspace: make(),
    storageConfig: make(),
  };
});

vi.mock('../db.js', () => ({ prisma: delegates }));

import { _resetKeyCacheForTests, decryptSecret, encryptSecret } from './crypto.js';
import { rotateEncryptionKey } from './keyRotation.js';

const OLD_KEY = randomBytes(32).toString('base64');
const NEW_KEY = randomBytes(32).toString('base64');

function useKey(version: 1 | 2) {
  if (version === 1) {
    process.env.CONFIG_ENCRYPTION_KEY = OLD_KEY;
    delete process.env.CONFIG_ENCRYPTION_KEY_VERSION;
    delete process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS;
  } else {
    process.env.CONFIG_ENCRYPTION_KEY = NEW_KEY;
    process.env.CONFIG_ENCRYPTION_KEY_VERSION = '2';
    process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS = OLD_KEY;
  }
  _resetKeyCacheForTests();
}

function credentialRow(id: string, secret: string): Row {
  useKey(1);
  const sealed = encryptSecret(secret);
  useKey(2);
  return {
    apiKeyAuthTag: sealed.authTag,
    apiKeyCiphertext: sealed.ciphertext,
    apiKeyNonce: sealed.nonce,
    id,
    keyVersion: sealed.keyVersion,
    lastFour: sealed.lastFour,
  };
}

const previousEnv = {
  key: process.env.CONFIG_ENCRYPTION_KEY,
  previous: process.env.CONFIG_ENCRYPTION_KEY_PREVIOUS,
  version: process.env.CONFIG_ENCRYPTION_KEY_VERSION,
};

beforeEach(() => {
  for (const d of Object.values(delegates)) {
    d.findMany.mockReset();
    d.findMany.mockResolvedValue([]);
    d.updateMany.mockReset();
    d.updateMany.mockResolvedValue({ count: 1 });
  }
});

afterEach(() => {
  for (const [k, v] of [
    ['CONFIG_ENCRYPTION_KEY', previousEnv.key],
    ['CONFIG_ENCRYPTION_KEY_PREVIOUS', previousEnv.previous],
    ['CONFIG_ENCRYPTION_KEY_VERSION', previousEnv.version],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  _resetKeyCacheForTests();
});

describe('rotateEncryptionKey — conditional write-back', () => {
  it('re-encrypts under the current key, guarded by the nonce and version it read', async () => {
    const row = credentialRow('c1', 'sk-original-1234');
    delegates.providerCredential.findMany.mockResolvedValue([row]);

    const report = await rotateEncryptionKey();

    expect(report.rotated).toEqual({ providerCredential: 1 });
    expect(report.conflicted).toEqual([]);
    const call = delegates.providerCredential.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ apiKeyNonce: row.apiKeyNonce, id: 'c1', keyVersion: 1 });
    expect(call.data.keyVersion).toBe(2);
    expect(
      decryptSecret({
        authTag: call.data.apiKeyAuthTag as Uint8Array<ArrayBuffer>,
        ciphertext: call.data.apiKeyCiphertext as Uint8Array<ArrayBuffer>,
        keyVersion: 2,
        nonce: call.data.apiKeyNonce as Uint8Array<ArrayBuffer>,
      })
    ).toBe('sk-original-1234');
  });

  it('does not overwrite a secret saved mid-rotation: the row is reported, not written', async () => {
    delegates.providerCredential.findMany.mockResolvedValue([
      credentialRow('c1', 'sk-old-aaaa'),
      credentialRow('c2', 'sk-old-bbbb'),
    ]);
    // c1 was re-saved by an admin between the read and the write, so the
    // guarded update matches nothing.
    delegates.providerCredential.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const report = await rotateEncryptionKey();

    expect(report.conflicted).toEqual([{ id: 'c1', model: 'providerCredential' }]);
    expect(report.rotated).toEqual({ providerCredential: 1 });
  });

  it('writes nothing on a dry run', async () => {
    delegates.providerCredential.findMany.mockResolvedValue([credentialRow('c1', 'sk-x-1111')]);
    const report = await rotateEncryptionKey({ dryRun: true });
    expect(report.rotated).toEqual({ providerCredential: 1 });
    expect(delegates.providerCredential.updateMany).not.toHaveBeenCalled();
  });
});
