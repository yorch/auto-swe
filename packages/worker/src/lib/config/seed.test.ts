import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { roleCount, credCount, roleCreate, credCreate } = vi.hoisted(() => ({
  credCount: vi.fn(),
  credCreate: vi.fn(),
  roleCount: vi.fn(),
  roleCreate: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    modelRoleConfig: { count: roleCount, create: roleCreate },
    providerCredential: { count: credCount, create: credCreate },
  },
}));

import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { seedConfigFromEnv } from './seed.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
  roleCount.mockReset();
  credCount.mockReset();
  roleCreate.mockReset();
  credCreate.mockReset();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('seedConfigFromEnv', () => {
  it('seeds all 6 GLOBAL role rows when the table is empty', async () => {
    roleCount.mockResolvedValue(0);
    credCount.mockResolvedValue(0);

    const result = await seedConfigFromEnv();

    expect(result.rolesSeeded).toBe(6);
    expect(roleCreate).toHaveBeenCalledTimes(6);
    const roles = roleCreate.mock.calls.map((c) => c[0].data.role).sort();
    expect(roles).toEqual([
      'COMMIT_TO_MEMORY',
      'IMPLEMENTER',
      'PLANNER',
      'REVIEWER',
      'SECURITY_REVIEW',
      'VALIDATE_CONTEXT',
    ]);
  });

  it('honors per-role env overrides in the seeded rows', async () => {
    roleCount.mockResolvedValue(0);
    credCount.mockResolvedValue(0);
    process.env.IMPLEMENTER_MODEL = 'openai/gpt-5-5';

    await seedConfigFromEnv();

    const implementer = roleCreate.mock.calls.find((c) => c[0].data.role === 'IMPLEMENTER');
    expect(implementer?.[0].data.modelSpec).toBe('openai/gpt-5-5');
  });

  it('skips role seeding when GLOBAL rows already exist', async () => {
    roleCount.mockResolvedValue(6);
    credCount.mockResolvedValue(0);

    const result = await seedConfigFromEnv();

    expect(result.rolesSeeded).toBe(0);
    expect(roleCreate).not.toHaveBeenCalled();
  });

  it('seeds built-in provider credentials from env vars', async () => {
    roleCount.mockResolvedValue(6);
    credCount.mockResolvedValue(0);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-1234';
    process.env.OPENAI_API_KEY = 'sk-openai-5678';

    await seedConfigFromEnv();

    const providers = credCreate.mock.calls.map((c) => c[0].data.provider).sort();
    expect(providers).toEqual(['anthropic', 'openai']);
    const ant = credCreate.mock.calls.find((c) => c[0].data.provider === 'anthropic');
    expect(ant?.[0].data.lastFour).toBe('1234');
  });

  it('discovers OpenAI-compatible providers from <X>_API_BASE + <X>_API_KEY pairs', async () => {
    roleCount.mockResolvedValue(6);
    credCount.mockResolvedValue(0);
    process.env.OPENCODEGO_API_BASE = 'https://opencode.ai/zen/go/v1';
    process.env.OPENCODEGO_API_KEY = 'sk-go-9999';

    await seedConfigFromEnv();

    const opencode = credCreate.mock.calls.find((c) => c[0].data.provider === 'opencodego');
    expect(opencode).toBeDefined();
    expect(opencode?.[0].data.apiBase).toBe('https://opencode.ai/zen/go/v1');
    expect(opencode?.[0].data.lastFour).toBe('9999');
  });

  it('skips <X>_API_BASE entries that lack a matching <X>_API_KEY', async () => {
    roleCount.mockResolvedValue(6);
    credCount.mockResolvedValue(0);
    process.env.NOKEY_API_BASE = 'https://foo/v1';
    delete process.env.NOKEY_API_KEY;

    await seedConfigFromEnv();

    expect(credCreate.mock.calls.find((c) => c[0].data.provider === 'nokey')).toBeUndefined();
  });

  it('is idempotent — seeding twice with non-empty tables creates nothing', async () => {
    roleCount.mockResolvedValue(6);
    credCount.mockResolvedValue(3);

    const result = await seedConfigFromEnv();

    expect(result.rolesSeeded).toBe(0);
    expect(result.credentialsSeeded).toBe(0);
    expect(roleCreate).not.toHaveBeenCalled();
    expect(credCreate).not.toHaveBeenCalled();
  });

  it('swallows P2002 unique-constraint failures from concurrent worker boots', async () => {
    roleCount.mockResolvedValue(0);
    credCount.mockResolvedValue(0);
    // Simulate: another worker won the race on every insert.
    const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    roleCreate.mockRejectedValue(conflict);
    credCreate.mockRejectedValue(conflict);
    process.env.ANTHROPIC_API_KEY = 'sk-foo';

    // Should NOT throw — concurrent seeds are expected and fine.
    const result = await seedConfigFromEnv();
    expect(result.rolesSeeded).toBe(0);
    expect(result.credentialsSeeded).toBe(0);
    // Attempts were still made for each role.
    expect(roleCreate).toHaveBeenCalledTimes(6);
  });

  it('re-throws non-P2002 errors from create()', async () => {
    roleCount.mockResolvedValue(0);
    credCount.mockResolvedValue(0);
    roleCreate.mockRejectedValue(new Error('connection refused'));

    await expect(seedConfigFromEnv()).rejects.toThrow(/connection refused/);
  });

  it('respects LLM_PROVIDER_AUTODISCOVER=false', async () => {
    roleCount.mockResolvedValue(6);
    credCount.mockResolvedValue(0);
    process.env.LLM_PROVIDER_AUTODISCOVER = 'false';
    process.env.OPENCODEGO_API_BASE = 'https://opencode.ai/zen/go/v1';
    process.env.OPENCODEGO_API_KEY = 'sk-go';

    await seedConfigFromEnv();

    expect(credCreate.mock.calls.find((c) => c[0].data.provider === 'opencodego')).toBeUndefined();
  });

  it('skips known non-LLM env-var prefixes (GITHUB, SLACK, AWS, etc.)', async () => {
    roleCount.mockResolvedValue(6);
    credCount.mockResolvedValue(0);
    process.env.GITHUB_API_BASE = 'https://api.github.com';
    process.env.GITHUB_API_KEY = 'ghp_abc';
    process.env.SLACK_API_BASE = 'https://slack.com/api';
    process.env.SLACK_API_KEY = 'xoxb-abc';

    await seedConfigFromEnv();

    const providers = credCreate.mock.calls.map((c) => c[0].data.provider);
    expect(providers).not.toContain('github');
    expect(providers).not.toContain('slack');
  });
});
