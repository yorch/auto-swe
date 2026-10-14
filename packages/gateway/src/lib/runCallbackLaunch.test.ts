import { randomBytes } from 'node:crypto';
import { _resetKeyCacheForTests } from '@auto-swe/shared/lib/crypto';
import { openCallbackUrl } from '@auto-swe/shared/lib/runCallbacks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveLaunchCallback, withoutCallback } from './runCallbackLaunch.js';

const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  _resetKeyCacheForTests();
});
afterAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
  _resetKeyCacheForTests();
});

const EP_ID = '22222222-2222-4222-8222-222222222222';

interface Endpoint {
  id: string;
  teamId: string;
  origin: string;
  pathPrefix: string;
  allowPrivateNetwork: boolean;
  disabledAt: Date | null;
}

const ENDPOINTS: Endpoint[] = [
  {
    allowPrivateNetwork: false,
    disabledAt: null,
    id: EP_ID,
    origin: 'https://hooks.example.com',
    pathPrefix: '/hooks',
    teamId: 'team-a',
  },
  {
    allowPrivateNetwork: false,
    disabledAt: null,
    id: 'ep-deeper',
    origin: 'https://hooks.example.com',
    pathPrefix: '/hooks/deep',
    teamId: 'team-a',
  },
  {
    allowPrivateNetwork: false,
    disabledAt: null,
    id: 'ep-other-team',
    origin: 'https://other.example.com',
    pathPrefix: '/',
    teamId: 'team-b',
  },
  {
    allowPrivateNetwork: false,
    disabledAt: new Date(),
    id: 'ep-disabled',
    origin: 'https://disabled.example.com',
    pathPrefix: '/',
    teamId: 'team-a',
  },
];

/** A `callbackEndpoint.findMany` that applies the filters the resolver passes. */
const prisma = {
  callbackEndpoint: {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: { id?: string; origin?: string; disabledAt: null; teamId?: { in: string[] } };
      }) =>
        ENDPOINTS.filter(
          (e) =>
            e.disabledAt === null &&
            (where.id === undefined || e.id === where.id) &&
            (where.origin === undefined || e.origin === where.origin) &&
            (where.teamId === undefined || where.teamId.in.includes(e.teamId))
        )
    ),
  },
} as unknown as Parameters<typeof resolveLaunchCallback>[0];

const TEAM_A = { kind: 'teams' as const, teamIds: ['team-a'] };

describe('resolveLaunchCallback', () => {
  it('writes nothing when the launch asks for no callback', async () => {
    expect(
      await resolveLaunchCallback(prisma, { callback: undefined, teams: TEAM_A, workflowId: 'wf' })
    ).toEqual({ create: null, ok: true, target: null });
  });

  it('seals the full URL, query included, and shows only origin and path', async () => {
    const result = await resolveLaunchCallback(prisma, {
      callback: { context: { k: 1 }, url: 'https://hooks.example.com/hooks/run?token=t0k' },
      teams: TEAM_A,
      workflowId: 'wf-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.create) {
      throw new Error('expected a callback');
    }
    expect(result.target).toBe('https://hooks.example.com/hooks/run');
    expect(result.create).toMatchObject({
      context: { k: 1 },
      endpointId: EP_ID,
      target: 'https://hooks.example.com/hooks/run',
      workflowId: 'wf-1',
    });
    expect(JSON.stringify(result.create)).not.toContain('t0k');
    expect(openCallbackUrl(result.create as never)).toBe(
      'https://hooks.example.com/hooks/run?token=t0k'
    );
  });

  it('picks the most specific matching prefix', async () => {
    const result = await resolveLaunchCallback(prisma, {
      callback: { url: 'https://hooks.example.com/hooks/deep/x' },
      teams: TEAM_A,
      workflowId: 'wf',
    });
    expect(result.ok && result.create?.endpointId).toBe('ep-deeper');
  });

  it('uses an endpoint by id as its origin and prefix', async () => {
    const result = await resolveLaunchCallback(prisma, {
      callback: { endpointId: EP_ID },
      teams: TEAM_A,
      workflowId: 'wf',
    });
    expect(result.ok && result.target).toBe('https://hooks.example.com/hooks');
  });

  it.each([
    ['https://hooks.example.com/hooks/../admin', 'INVALID_CALLBACK_URL'],
    ['https://hooks.example.com/hooks/%2e%2e/admin', 'INVALID_CALLBACK_URL'],
    ['https://user:pw@hooks.example.com/hooks', 'INVALID_CALLBACK_URL'],
    ['https://hooks.example.com/hooks#frag', 'INVALID_CALLBACK_URL'],
    ['https://hooks.example.com/admin', 'CALLBACK_URL_NOT_REGISTERED'],
    ['https://hooks.example.com:8443/hooks', 'CALLBACK_URL_NOT_REGISTERED'],
    ['http://hooks.example.com/hooks', 'CALLBACK_URL_NOT_REGISTERED'],
    ['https://other.example.com/x', 'CALLBACK_URL_NOT_REGISTERED'],
    ['https://disabled.example.com/x', 'CALLBACK_URL_NOT_REGISTERED'],
  ])('refuses %s with %s', async (url, code) => {
    const result = await resolveLaunchCallback(prisma, {
      callback: { url },
      teams: TEAM_A,
      workflowId: 'wf',
    });
    expect(result).toMatchObject({ code, ok: false, status: 400 });
  });

  it('refuses another team’s endpoint by id', async () => {
    const result = await resolveLaunchCallback(prisma, {
      callback: { endpointId: 'ep-other-team' },
      teams: TEAM_A,
      workflowId: 'wf',
    });
    expect(result).toMatchObject({ code: 'CALLBACK_ENDPOINT_NOT_FOUND', ok: false });
  });

  it('refuses a URL that two endpoints claim equally', async () => {
    ENDPOINTS.push({ ...(ENDPOINTS[0] as Endpoint), id: 'ep-dup', teamId: 'team-b' });
    try {
      const result = await resolveLaunchCallback(prisma, {
        callback: { url: 'https://hooks.example.com/hooks/x' },
        teams: { kind: 'any' },
        workflowId: 'wf',
      });
      expect(result).toMatchObject({ code: 'CALLBACK_URL_AMBIGUOUS', ok: false });
    } finally {
      ENDPOINTS.pop();
    }
  });

  it('refuses everything for a caller in no team', async () => {
    const result = await resolveLaunchCallback(prisma, {
      callback: { url: 'https://hooks.example.com/hooks' },
      teams: { kind: 'teams', teamIds: [] },
      workflowId: 'wf',
    });
    expect(result).toMatchObject({ code: 'CALLBACK_URL_NOT_REGISTERED', ok: false });
  });
});

describe('withoutCallback', () => {
  it('drops the callback from what is stored as the raw request', () => {
    expect(withoutCallback({ callback: { url: 'x?token=t' }, label: 'a' })).toEqual({ label: 'a' });
  });
});
