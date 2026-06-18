import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentFindFirst } = vi.hoisted(() => ({ agentFindFirst: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { agent: { findFirst: agentFindFirst } },
}));

// Pass-through cache so resolution isn't memoized across cases.
vi.mock('./cache.js', () => ({
  configCacheTtlMs: () => 0,
  withCache: (_k: string, _t: number, fn: () => unknown) => fn(),
}));

vi.mock('../providerUtils.js', () => ({
  parseProviderModelSpec: (spec: string) => ({
    modelId: spec.split('/')[1] ?? '',
    provider: spec.split('/')[0] ?? '',
  }),
}));

vi.mock('./resolver.js', () => ({
  ConfigMissingError: class ConfigMissingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigMissingError';
    }
  },
  resolveProviderCredential: vi.fn().mockResolvedValue({ apiBase: undefined, apiKey: 'sk-cred' }),
}));

import { resolveAgent } from './agentResolver.js';
import { ConfigMissingError, resolveProviderCredential } from './resolver.js';

const mockedResolveCred = vi.mocked(resolveProviderCredential);

function skillRef(name: string, sortOrder: number) {
  return {
    skill: {
      description: `${name} desc`,
      id: `sk-${name}`,
      isActive: true,
      isVerified: true,
      name,
      promptText: `PROMPT_${name}`,
    },
    sortOrder,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test row factory
function agentRow(overrides: Record<string, any> = {}) {
  return {
    credentialId: null,
    description: 'd',
    id: 'a-1',
    inheritsModelFrom: null,
    isActive: true,
    isBuiltIn: true,
    isVerified: true,
    key: 'reviewer',
    modelSpec: 'anthropic/claude-opus-4-8',
    origin: 'swe-starter',
    scope: 'GLOBAL',
    skillRefs: [],
    systemPrompt: null,
    teamId: null,
    toolKeys: null,
    version: 1,
    workflowTemplateId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveCred.mockResolvedValue({ apiBase: undefined, apiKey: 'sk-cred' });
});

describe('resolveAgent — reads from the Agent entity', () => {
  it('resolves model + skills + tools from the Agent row', async () => {
    agentFindFirst.mockResolvedValue(
      agentRow({
        skillRefs: [skillRef('a', 0), skillRef('b', 1)],
        systemPrompt: 'SYS',
        toolKeys: ['readFile', 'bash'],
      })
    );

    const r = await resolveAgent('reviewer');

    expect(r.model).toEqual({
      apiBase: undefined,
      apiKey: 'sk-cred',
      scope: 'GLOBAL',
      spec: 'anthropic/claude-opus-4-8',
      systemPrompt: 'SYS',
    });
    expect(r.skills.map((s) => s.name)).toEqual(['a', 'b']);
    expect(r.toolKeys).toEqual(['readFile', 'bash']);
    expect(r.version).toBe(1);
    expect(mockedResolveCred).toHaveBeenCalledWith('anthropic', undefined);
  });

  it('returns null toolKeys when the column is null', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ toolKeys: null }));
    const r = await resolveAgent('reviewer');
    expect(r.toolKeys).toBeNull();
  });

  it('filters inactive skills out of skillRefs', async () => {
    const ref = skillRef('x', 0);
    ref.skill.isActive = false;
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [ref] }));
    const r = await resolveAgent('reviewer');
    expect(r.skills).toEqual([]);
  });
});

describe('resolveAgent — model inheritance', () => {
  it('chases inheritsModelFrom to the parent agent that carries the modelSpec', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      if (args.where.key === 'securityReviewer') {
        return agentRow({
          inheritsModelFrom: 'reviewer',
          key: 'securityReviewer',
          modelSpec: null,
          skillRefs: [skillRef('sec', 0)],
        });
      }
      return agentRow({ key: 'reviewer', modelSpec: 'anthropic/claude-opus-4-8' });
    });

    const r = await resolveAgent('securityReviewer');

    expect(r.model.spec).toBe('anthropic/claude-opus-4-8');
    expect(r.skills.map((s) => s.name)).toEqual(['sec']); // sub-role's own skills
    expect(mockedResolveCred).toHaveBeenCalledWith('anthropic', undefined);
  });

  it('throws ConfigMissingError when the inherited parent is missing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) =>
      args.where.key === 'securityReviewer'
        ? agentRow({ inheritsModelFrom: 'reviewer', key: 'securityReviewer', modelSpec: null })
        : null
    );
    await expect(resolveAgent('securityReviewer')).rejects.toThrow(ConfigMissingError);
  });
});

describe('resolveAgent — missing agent', () => {
  it('throws ConfigMissingError when no Agent row exists', async () => {
    agentFindFirst.mockResolvedValue(null);
    await expect(resolveAgent('nope')).rejects.toThrow(ConfigMissingError);
  });

  it('throws ConfigMissingError when the agent has no model and no inheritance', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ inheritsModelFrom: null, modelSpec: null }));
    await expect(resolveAgent('reviewer')).rejects.toThrow(ConfigMissingError);
  });
});

describe('resolveAgent — run-start version pin', () => {
  it('queries the pinned version from ctx.agentVersions', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    let capturedWhere: any;
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      capturedWhere = args.where;
      return agentRow({ version: 2 });
    });

    const r = await resolveAgent('reviewer', { agentVersions: { reviewer: 2 } });
    expect(capturedWhere).toMatchObject({ key: 'reviewer', scope: 'GLOBAL', version: 2 });
    expect(r.version).toBe(2);
  });
});

describe('resolveAgent — scope cascade', () => {
  it('prefers a TEAM Agent row over GLOBAL', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) =>
      args.where.scope === 'TEAM' ? agentRow({ scope: 'TEAM', version: 7 }) : agentRow()
    );
    const r = await resolveAgent('reviewer', { teamId: 't1' });
    expect(r.version).toBe(7);
  });
});
