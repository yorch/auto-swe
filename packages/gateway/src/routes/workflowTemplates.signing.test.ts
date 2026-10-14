import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIGNING_ROTATION_OVERLAP_MS,
  type TemplateSigningColumns,
  templateWebhookSecrets,
} from '../lib/templateWebhookSigning.js';
import { workflowTemplateRoutes } from './workflowTemplates.js';

process.env.CONFIG_ENCRYPTION_KEY ??= Buffer.alloc(32, 5).toString('base64');

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSetting: vi.fn(async () => false),
}));

/**
 * The signing-secret routes on a template's webhook: rotate (secret shown once, the replaced one
 * kept for 24 h), remove, and the require-signature switch. Same permission as the token routes
 * (LEAD+, a template the caller may edit), audited without the secret.
 */

const ID = 'cccccccc-3333-4333-8333-cccccccccccc';
type Row = Record<string, unknown>;

interface Harness {
  app: FastifyInstance;
  row: Row;
  audits: Row[];
  role: string;
  /** Simulates another rotation landing between this route's read and its write. */
  raceOnce: boolean;
}

async function build(): Promise<Harness> {
  const h: Harness = {
    app: Fastify(),
    audits: [],
    raceOnce: false,
    role: 'LEAD',
    row: {
      id: ID,
      name: 'deploy hook',
      origin: null,
      teamId: 'team-1',
      webhookRequireSignature: false,
      webhookSigningSecretCiphertext: null,
      webhookSigningSecretNonce: null,
      webhookToken: 'tok',
    },
  };
  h.app.setValidatorCompiler(validatorCompiler);
  h.app.setSerializerCompiler(serializerCompiler);
  h.app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9_999_999_999, iat: 0, role: h.role, sub: 'user-1' }),
  } as unknown as never);
  const sameNonce = (a: unknown, b: unknown) =>
    a == null || b == null
      ? a == null && b == null
      : Buffer.from(a as Uint8Array).equals(Buffer.from(b as Uint8Array));
  h.app.decorate('prisma', {
    configAuditLog: {
      create: async ({ data }: { data: Row }) => {
        h.audits.push(data);
        return data;
      },
    },
    workflowTemplate: {
      findFirst: async ({ where }: { where: Row }) => (where.id === ID ? { ...h.row } : null),
      update: async ({ data }: { data: Row }) => {
        Object.assign(h.row, data);
        return { ...h.row };
      },
      updateMany: async ({ data, where }: { data: Row; where: Row }) => {
        if (h.raceOnce) {
          h.raceOnce = false;
          return { count: 0 };
        }
        const expected = where.webhookSigningSecretNonce as { equals?: unknown } | null;
        if (
          where.id !== ID ||
          !sameNonce(expected?.equals ?? null, h.row.webhookSigningSecretNonce)
        ) {
          return { count: 0 };
        }
        Object.assign(h.row, data);
        return { count: 1 };
      },
    },
  } as unknown as never);
  await h.app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  await h.app.ready();
  return h;
}

const call = (h: Harness, method: 'POST' | 'DELETE' | 'PUT', suffix: string, payload?: object) =>
  h.app.inject({
    headers: { authorization: 'Bearer x' },
    method,
    ...(payload ? { payload } : {}),
    url: `/api/v1/workflow-templates/${ID}${suffix}`,
  });

const decrypt = (row: Row, prefix: string) =>
  decryptSecret({
    authTag: row[`${prefix}AuthTag`] as Uint8Array,
    ciphertext: row[`${prefix}Ciphertext`] as Uint8Array,
    keyVersion: row[`${prefix}KeyVersion`] as number,
    nonce: row[`${prefix}Nonce`] as Uint8Array,
  });

describe('template webhook signing routes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await build();
  });
  afterEach(() => h.app.close());

  it('generates a secret, returns it once, stores it sealed and audits without it', async () => {
    const res = await call(h, 'POST', '/webhook/signing-secret/rotate');
    expect(res.statusCode).toBe(200);
    const { signingSecret, webhookSigning } = res.json().data;
    expect(signingSecret).toMatch(/^whsec_/);
    expect(webhookSigning).toMatchObject({ configured: true, previousExpiresAt: null });
    expect(decrypt(h.row, 'webhookSigningSecret')).toBe(signingSecret);
    expect(h.row.webhookPreviousSigningSecretCiphertext).toBeNull();
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'UPDATE',
      afterJson: { webhookSigningSecretConfigured: true },
      beforeJson: { webhookSigningSecretConfigured: false },
      entityType: 'WorkflowTemplate',
    });
    expect(JSON.stringify(h.audits)).not.toContain(signingSecret);
    // Later reads never carry it.
    expect(JSON.stringify(h.row)).not.toContain(signingSecret);
  });

  it('rotation keeps the replaced secret as previous for 24 hours', async () => {
    const first = (await call(h, 'POST', '/webhook/signing-secret/rotate')).json().data
      .signingSecret as string;
    const before = Date.now();
    const res = await call(h, 'POST', '/webhook/signing-secret/rotate');
    const second = res.json().data.signingSecret as string;
    expect(second).not.toBe(first);
    expect(decrypt(h.row, 'webhookSigningSecret')).toBe(second);
    expect(decrypt(h.row, 'webhookPreviousSigningSecret')).toBe(first);
    const expires = (h.row.webhookPreviousSigningSecretExpiresAt as Date).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + SIGNING_ROTATION_OVERLAP_MS);
    expect(expires).toBeLessThan(before + SIGNING_ROTATION_OVERLAP_MS + 60_000);
    expect(res.json().data.webhookSigning.previousExpiresAt).toBeTruthy();
    // Both are accepted during the overlap, current first.
    expect(templateWebhookSecrets(h.row as unknown as TemplateSigningColumns, new Date())).toEqual([
      second,
      first,
    ]);
  });

  it('refuses a rotation that raced another one instead of handing out a lost secret', async () => {
    h.raceOnce = true;
    const res = await call(h, 'POST', '/webhook/signing-secret/rotate');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SIGNING_SECRET_CHANGED');
    expect(h.audits).toHaveLength(0);
  });

  it('will not require signatures before a secret exists', async () => {
    const res = await call(h, 'PUT', '/webhook/require-signature', { required: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('WEBHOOK_SIGNING_NOT_CONFIGURED');
    expect(h.row.webhookRequireSignature).toBe(false);
  });

  it('toggles require-signature, audited, and refuses removal while it is on', async () => {
    await call(h, 'POST', '/webhook/signing-secret/rotate');
    h.audits.length = 0;

    const on = await call(h, 'PUT', '/webhook/require-signature', { required: true });
    expect(on.statusCode).toBe(200);
    expect(on.json().data.webhookSigning.requireSignature).toBe(true);
    expect(h.audits.at(-1)).toMatchObject({
      afterJson: { webhookRequireSignature: true },
      beforeJson: { webhookRequireSignature: false },
    });

    const removal = await call(h, 'DELETE', '/webhook/signing-secret');
    expect(removal.statusCode).toBe(409);
    expect(removal.json().error.code).toBe('WEBHOOK_SIGNATURE_REQUIRED');

    await call(h, 'PUT', '/webhook/require-signature', { required: false });
    const removed = await call(h, 'DELETE', '/webhook/signing-secret');
    expect(removed.statusCode).toBe(204);
    expect(h.row.webhookSigningSecretCiphertext).toBeNull();
    expect(h.row.webhookPreviousSigningSecretCiphertext).toBeNull();
    expect(h.audits.at(-1)).toMatchObject({
      afterJson: { webhookSigningSecretConfigured: false },
      beforeJson: { webhookSigningSecretConfigured: true },
    });
  });

  it('needs platform LEAD, like the token routes', async () => {
    h.role = 'ENGINEER';
    for (const [method, suffix, payload] of [
      ['POST', '/webhook/signing-secret/rotate', undefined],
      ['DELETE', '/webhook/signing-secret', undefined],
      ['PUT', '/webhook/require-signature', { required: false }],
    ] as const) {
      expect((await call(h, method, suffix, payload)).statusCode).toBe(403);
    }
  });

  it('404s a template the caller may not edit', async () => {
    const res = await h.app.inject({
      headers: { authorization: 'Bearer x' },
      method: 'POST',
      url: '/api/v1/workflow-templates/dddddddd-4444-4444-8444-dddddddddddd/webhook/signing-secret/rotate',
    });
    expect(res.statusCode).toBe(404);
  });
});
