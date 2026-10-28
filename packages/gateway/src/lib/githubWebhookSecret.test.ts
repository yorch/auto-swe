import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyGitHubSignature } from './github.js';

const state = vi.hoisted(() => ({
  approved: ['ghe.corp', 'ghe.corp:8443', 'other.corp'] as string[],
  instanceSecret: 'instance-secret' as string | null,
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: async () => ({ webhookSecret: state.instanceSecret }),
}));

vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  approvedRepositoryHosts: async () => state.approved,
}));

// The "ciphertext" is the plaintext, so a row's secret is visible in the test.
vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: (r: { ciphertext: Uint8Array }) => Buffer.from(r.ciphertext).toString('utf8'),
}));

const {
  clearWebhookSecretCache,
  enterpriseHostOf,
  HOST_ROW_CACHE_MAX,
  HOST_ROW_TTL_MS,
  resolveWebhookSecret,
} = await import('./githubWebhookSecret.js');

function prismaWith(rows: Record<string, string>) {
  const toRow = (host: string) => ({
    host,
    secretAuthTag: new Uint8Array(),
    secretCiphertext: Buffer.from(rows[host]),
    secretKeyVersion: 1,
    secretNonce: new Uint8Array(),
  });
  const findUnique = vi.fn(async ({ where }: { where: { host: string } }) =>
    where.host in rows ? toRow(where.host) : null
  );
  // Enough of the `OR: [{ host }, { host: { startsWith } }]` filter to be real.
  const findMany = vi.fn(
    async ({ where }: { where: { OR: Array<{ host: string | { startsWith: string } }> } }) =>
      Object.keys(rows)
        .filter((host) =>
          where.OR.some((c) =>
            typeof c.host === 'string' ? host === c.host : host.startsWith(c.host.startsWith)
          )
        )
        .map(toRow)
  );
  return {
    findMany,
    findUnique,
    prisma: { gitHubHostWebhookSecret: { findMany, findUnique } } as never,
  };
}

/** The decision `verifyWebhookOrReject` makes: one secret, chosen by host. */
async function accepts(
  prisma: never,
  header: string | undefined,
  payload: string,
  signedWith: string
): Promise<boolean> {
  const resolved = await resolveWebhookSecret(prisma, header);
  if (resolved.status !== 'resolved' || resolved.secret === null) {
    return false;
  }
  const signature = `sha256=${crypto.createHmac('sha256', signedWith).update(payload).digest('hex')}`;
  return verifyGitHubSignature(payload, signature, resolved.secret);
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
    clearWebhookSecretCache();
    state.instanceSecret = 'instance-secret';
    state.approved = ['ghe.corp', 'ghe.corp:8443', 'other.corp'];
  });

  it('verifies with the host secret when the header names a host that has one', async () => {
    const { prisma } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await accepts(prisma, 'ghe.corp', 'body', 'host-secret')).toBe(true);
  });

  it('names the host the secret proves, and none for the instance secret', async () => {
    const { prisma } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toMatchObject({
      host: 'ghe.corp',
      status: 'resolved',
    });
    expect(await resolveWebhookSecret(prisma, 'other.corp')).toMatchObject({
      host: null,
      status: 'resolved',
    });
    expect(await resolveWebhookSecret(prisma, undefined)).toMatchObject({ host: null });
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
  });

  it('matches a hostname-only header to the single row with that hostname, port or not', async () => {
    const { prisma } = prismaWith({ 'ghe.corp:8443': 'host-secret' });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toMatchObject({
      host: 'ghe.corp:8443',
    });
    expect(await accepts(prisma, 'ghe.corp', 'body', 'host-secret')).toBe(true);
    expect(await accepts(prisma, 'ghe.corp', 'body', 'instance-secret')).toBe(false);
  });

  it('prefers the exact host[:port] row over a hostname match', async () => {
    const { prisma } = prismaWith({ 'ghe.corp': 'plain', 'ghe.corp:8443': 'ported' });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp:8443')).toMatchObject({
      host: 'ghe.corp:8443',
    });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toMatchObject({ host: 'ghe.corp' });
  });

  it('matches no row when several share the hostname and none is exact', async () => {
    state.approved.push('ghe.corp:9000');
    const { prisma } = prismaWith({ 'ghe.corp:8443': 'a', 'ghe.corp:9000': 'b' });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toMatchObject({ host: null });
  });

  it('does not treat a longer hostname as the same host', async () => {
    const { prisma } = prismaWith({ 'ghe.corp.evil:8443': 'host-secret' });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toMatchObject({ host: null });
  });

  it('refuses a row whose host is no longer approved, rather than using the instance secret', async () => {
    state.approved = ['other.corp'];
    const { prisma } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toEqual({
      host: 'ghe.corp',
      status: 'host_not_approved',
    });
    expect(await accepts(prisma, 'ghe.corp', 'body', 'host-secret')).toBe(false);
    expect(await accepts(prisma, 'ghe.corp', 'body', 'instance-secret')).toBe(false);
  });

  it('is unresolved (null secret) when none is configured anywhere', async () => {
    state.instanceSecret = null;
    const { prisma } = prismaWith({});
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toEqual({
      host: null,
      secret: null,
      status: 'resolved',
    });
  });
});

describe('resolveWebhookSecret: the host lookup is remembered briefly', () => {
  beforeEach(() => {
    clearWebhookSecretCache();
    state.instanceSecret = 'instance-secret';
    state.approved = ['ghe.corp', 'other.corp'];
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the row once for repeated deliveries naming one host, spelled any way', async () => {
    const { prisma, findUnique } = prismaWith({ 'ghe.corp': 'host-secret' });
    await resolveWebhookSecret(prisma, 'ghe.corp');
    await resolveWebhookSecret(prisma, 'GHE.Corp');
    await resolveWebhookSecret(prisma, ' ghe.corp ');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('remembers a host with no row too, so a made-up host costs one lookup per window', async () => {
    const { prisma, findUnique, findMany } = prismaWith({});
    for (let i = 0; i < 5; i++) {
      expect(await resolveWebhookSecret(prisma, 'nobody.example')).toMatchObject({ host: null });
    }
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('reads again once the window has passed, so a rotated secret takes effect', async () => {
    const rows: Record<string, string> = { 'ghe.corp': 'old-secret' };
    const { prisma, findUnique } = prismaWith(rows);
    expect(await accepts(prisma, 'ghe.corp', 'body', 'old-secret')).toBe(true);
    rows['ghe.corp'] = 'new-secret';
    expect(await accepts(prisma, 'ghe.corp', 'body', 'new-secret')).toBe(false);
    vi.setSystemTime(Date.now() + HOST_ROW_TTL_MS + 1);
    expect(await accepts(prisma, 'ghe.corp', 'body', 'new-secret')).toBe(true);
    expect(await accepts(prisma, 'ghe.corp', 'body', 'old-secret')).toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('forgets everything on clearWebhookSecretCache', async () => {
    const { prisma, findUnique } = prismaWith({ 'ghe.corp': 'host-secret' });
    await resolveWebhookSecret(prisma, 'ghe.corp');
    clearWebhookSecretCache();
    await resolveWebhookSecret(prisma, 'ghe.corp');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('never remembers a failed lookup', async () => {
    const { prisma, findUnique } = prismaWith({ 'ghe.corp': 'host-secret' });
    findUnique.mockRejectedValueOnce(new Error('database down'));
    await expect(resolveWebhookSecret(prisma, 'ghe.corp')).rejects.toThrow('database down');
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toMatchObject({ host: 'ghe.corp' });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('still checks approval on every delivery, so a lost approval refuses at once', async () => {
    const { prisma } = prismaWith({ 'ghe.corp': 'host-secret' });
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toMatchObject({ status: 'resolved' });
    state.approved = ['other.corp'];
    expect(await resolveWebhookSecret(prisma, 'ghe.corp')).toEqual({
      host: 'ghe.corp',
      status: 'host_not_approved',
    });
  });

  it('is bounded: the oldest host is dropped past the maximum', async () => {
    const { prisma, findUnique } = prismaWith({});
    for (let i = 0; i <= HOST_ROW_CACHE_MAX; i++) {
      await resolveWebhookSecret(prisma, `h${i}.example`);
    }
    findUnique.mockClear();
    await resolveWebhookSecret(prisma, `h${HOST_ROW_CACHE_MAX}.example`);
    expect(findUnique).not.toHaveBeenCalled();
    await resolveWebhookSecret(prisma, 'h0.example');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
