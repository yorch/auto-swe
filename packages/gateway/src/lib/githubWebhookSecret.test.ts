import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyGitHubSignature } from './github.js';

const state = vi.hoisted(() => ({ instanceSecret: 'instance-secret' as string | null }));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({ webhookSecret: state.instanceSecret }),
}));

// The "ciphertext" is the plaintext, so a row's secret is visible in the test.
vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: (r: { ciphertext: Uint8Array }) => Buffer.from(r.ciphertext).toString('utf8'),
}));

const { enterpriseHostOf, resolveWebhookSecret } = await import('./githubWebhookSecret.js');

function prismaWith(rows: Record<string, string>) {
  const findUnique = vi.fn(async ({ where }: { where: { host: string } }) =>
    where.host in rows
      ? {
          secretAuthTag: new Uint8Array(),
          secretCiphertext: Buffer.from(rows[where.host]),
          secretKeyVersion: 1,
          secretNonce: new Uint8Array(),
        }
      : null
  );
  return { findUnique, prisma: { gitHubHostWebhookSecret: { findUnique } } as never };
}

/** The decision `verifyWebhookOrReject` makes: one secret, chosen by host. */
async function accepts(
  prisma: never,
  header: string | undefined,
  payload: string,
  signedWith: string
): Promise<boolean> {
  const secret = await resolveWebhookSecret(prisma, header);
  const signature = `sha256=${crypto.createHmac('sha256', signedWith).update(payload).digest('hex')}`;
  return secret !== null && verifyGitHubSignature(payload, signature, secret);
}

describe('enterpriseHostOf', () => {
  it('lowercases and trims, and treats absent or blank as none', () => {
    expect(enterpriseHostOf('GHE.Corp:8443')).toBe('ghe.corp:8443');
    expect(enterpriseHostOf('  ghe.corp ')).toBe('ghe.corp');
    expect(enterpriseHostOf(undefined)).toBeNull();
    expect(enterpriseHostOf('  ')).toBeNull();
    expect(enterpriseHostOf(['a', 'b'])).toBeNull();
  });
});

describe('resolveWebhookSecret', () => {
  beforeEach(() => {
    state.instanceSecret = 'instance-secret';
  });

  it('verifies with the host secret when the header names a host that has one', async () => {
    const { prisma } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await accepts(prisma, 'ghe.corp', 'body', 'host-secret')).toBe(true);
  });

  it('rejects an instance-signed payload from a host that has its own secret', async () => {
    const { prisma } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await accepts(prisma, 'ghe.corp', 'body', 'instance-secret')).toBe(false);
  });

  it('falls back to the instance secret for a host with no row', async () => {
    const { prisma } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await accepts(prisma, 'other.corp', 'body', 'instance-secret')).toBe(true);
    expect(await accepts(prisma, 'other.corp', 'body', 'host-secret')).toBe(false);
  });

  it('uses the instance secret, and reads no row, when there is no header', async () => {
    const { prisma, findUnique } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await accepts(prisma, undefined, 'body', 'instance-secret')).toBe(true);
    expect(await accepts(prisma, undefined, 'body', 'host-secret')).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('matches the header case-insensitively, port included', async () => {
    const { prisma, findUnique } = prismaWith({ 'ghe.corp:8443': 'host-secret' });
    expect(await accepts(prisma, 'GHE.Corp:8443', 'body', 'host-secret')).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { host: 'ghe.corp:8443' } });
    // A different port is a different host.
    expect(await accepts(prisma, 'ghe.corp', 'body', 'instance-secret')).toBe(true);
  });

  it('is null when no secret is configured anywhere', async () => {
    state.instanceSecret = null;
    const { prisma } = prismaWith({});
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toBeNull();
  });
});
