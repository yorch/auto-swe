import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentFindFirst, cacheKeys, invalidateMock } = vi.hoisted(() => ({
  agentFindFirst: vi.fn(),
  cacheKeys: [] as string[],
  invalidateMock: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { agent: { findFirst: agentFindFirst } },
}));

// Pass-through cache so resolution isn't memoized across cases; records the
// keys so a test can assert what would (not) collide within the TTL.
vi.mock('@auto-swe/shared/config/cache', () => ({
  configCacheTtlMs: () => 0,
  invalidate: invalidateMock,
  withCache: (k: string, _t: number, fn: () => unknown) => {
    cacheKeys.push(k);
    return fn();
  },
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

  it('does not apply the GLOBAL pin to a scoped override (TEAM v1 + GLOBAL v2, pin 2)', async () => {
    // The pin is snapshotted from the GLOBAL lineage; a TEAM row numbered v1
    // is a different lineage, not an older version. Filtering the TEAM query
    // by version=2 found nothing and silently fell through to GLOBAL.
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    const wheres: any[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      wheres.push(args.where);
      if (args.where.scope === 'TEAM') {
        return args.where.version === undefined
          ? agentRow({ scope: 'TEAM', teamId: 't1', version: 1 })
          : null;
      }
      return agentRow({ version: 2 });
    });

    const r = await resolveAgent('reviewer', { agentVersions: { reviewer: 2 }, teamId: 't1' });
    expect(r.model.scope).toBe('TEAM');
    expect(r.version).toBe(1);
    expect(wheres.find((w) => w.scope === 'TEAM')).not.toHaveProperty('version');
  });

  it('still freezes a run that falls through to GLOBAL at the pinned version', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    const wheres: any[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      wheres.push(args.where);
      return args.where.scope === 'GLOBAL' ? agentRow({ version: 2 }) : null;
    });
    const r = await resolveAgent('reviewer', { agentVersions: { reviewer: 2 }, teamId: 't1' });
    expect(r.version).toBe(2);
    expect(wheres.find((w) => w.scope === 'GLOBAL')).toMatchObject({ version: 2 });
  });
});

describe('resolveAgent — cache key', () => {
  it('keys on the whole pin map so inheritsModelFrom arms do not share an entry', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) =>
      args.where.key === 'securityReviewer'
        ? agentRow({ inheritsModelFrom: 'reviewer', key: 'securityReviewer', modelSpec: null })
        : agentRow({ key: 'reviewer', version: args.where.version ?? 1 })
    );
    cacheKeys.length = 0;
    await resolveAgent('securityReviewer', { agentVersions: { reviewer: 2, securityReviewer: 1 } });
    await resolveAgent('securityReviewer', { agentVersions: { reviewer: 3, securityReviewer: 1 } });
    // Same child pin, different parent pin → different entries.
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);

    // Insertion order of the pin map must not split the cache.
    cacheKeys.length = 0;
    await resolveAgent('securityReviewer', { agentVersions: { reviewer: 2, securityReviewer: 1 } });
    await resolveAgent('securityReviewer', { agentVersions: { reviewer: 2, securityReviewer: 1 } });
    expect(cacheKeys[0]).toBe(cacheKeys[1]);
  });
});

describe('resolveAgent — cross-scope fall-through is not cached', () => {
  it('busts the narrow key when a TEAM lookup lands on GLOBAL', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) =>
      args.where.scope === 'GLOBAL' ? agentRow() : null
    );
    cacheKeys.length = 0;
    const r = await resolveAgent('reviewer', { teamId: 't1' });
    expect(r.model.scope).toBe('GLOBAL');
    expect(invalidateMock).toHaveBeenCalledWith(cacheKeys[0]);
  });

  it('keeps the entry when the requested scope itself answered', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) =>
      args.where.scope === 'TEAM' ? agentRow({ scope: 'TEAM' }) : agentRow()
    );
    await resolveAgent('reviewer', { teamId: 't1' });
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('keeps a GLOBAL entry for a GLOBAL-only lookup', async () => {
    agentFindFirst.mockResolvedValue(agentRow());
    await resolveAgent('reviewer');
    expect(invalidateMock).not.toHaveBeenCalled();
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

  it('prefers an ORGANIZATION row over GLOBAL when no TEAM row exists (P5)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      if (args.where.scope === 'TEAM') {
        return null;
      }
      if (args.where.scope === 'ORGANIZATION') {
        return agentRow({ orgId: 'o1', scope: 'ORGANIZATION', version: 5 });
      }
      return agentRow();
    });
    const r = await resolveAgent('reviewer', { orgId: 'o1', teamId: 't1' });
    expect(r.model.scope).toBe('ORGANIZATION');
    expect(r.version).toBe(5);
  });

  it('TEAM wins over ORGANIZATION which wins over GLOBAL (P5)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      if (args.where.scope === 'TEAM') {
        return agentRow({ scope: 'TEAM', version: 9 });
      }
      if (args.where.scope === 'ORGANIZATION') {
        return agentRow({ orgId: 'o1', scope: 'ORGANIZATION', version: 5 });
      }
      return agentRow();
    });
    const r = await resolveAgent('reviewer', { orgId: 'o1', teamId: 't1' });
    expect(r.version).toBe(9); // TEAM is most specific
  });

  it('falls through ORGANIZATION to GLOBAL when no org row exists (P5)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) =>
      args.where.scope === 'GLOBAL' ? agentRow({ version: 1 }) : null
    );
    const r = await resolveAgent('reviewer', { orgId: 'o1', teamId: 't1' });
    expect(r.model.scope).toBe('GLOBAL');
    expect(r.version).toBe(1);
  });
});
