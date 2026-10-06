import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  agentFindFirst,
  cacheKeys,
  inActivity,
  invalidateMock,
  persistTrace,
  revisionFindMany,
  warn,
} = vi.hoisted(() => ({
  agentFindFirst: vi.fn(),
  cacheKeys: [] as string[],
  inActivity: { value: false },
  invalidateMock: vi.fn(),
  persistTrace: vi.fn(async () => undefined),
  revisionFindMany: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@temporalio/activity', () => ({
  asyncLocalStorage: { getStore: () => (inActivity.value ? {} : undefined) },
}));
vi.mock('../activityContext.js', () => ({ persistActivityTrace: persistTrace }));
vi.mock('../activityLog.js', () => ({ logWarn: warn }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { agent: { findFirst: agentFindFirst }, skillRevision: { findMany: revisionFindMany } },
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

vi.mock('@auto-swe/shared/lib/modelSpec', () => ({
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

import { resolveAgent, resolveAgentRuntimeChoice } from './agentResolver.js';
import { ConfigMissingError, resolveProviderCredential } from './resolver.js';

const mockedResolveCred = vi.mocked(resolveProviderCredential);

function skillRef(name: string, sortOrder: number) {
  return {
    skill: {
      currentRevision: 1,
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
    runtime: null,
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

describe('resolveAgent — run-start skill revision pin', () => {
  // The skill was edited after the run began: live text is revision 3, the run
  // pinned revision 1.
  function editedSkillRef() {
    const ref = skillRef('tdd', 0);
    ref.skill.currentRevision = 3;
    ref.skill.promptText = 'PROMPT_tdd (edited mid-run)';
    ref.skill.description = 'tdd desc (edited)';
    return ref;
  }

  it('reads the pinned revision text even though the skill was edited since', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [editedSkillRef()] }));
    revisionFindMany.mockResolvedValue([
      { description: 'tdd desc', promptText: 'PROMPT_tdd', revision: 1, skillId: 'sk-tdd' },
    ]);

    const r = await resolveAgent('reviewer', { skillRevisions: { 'sk-tdd': 1 } });

    expect(r.skills).toEqual([
      expect.objectContaining({
        description: 'tdd desc',
        // A pinned older revision is never reported as verified.
        isVerified: false,
        promptText: 'PROMPT_tdd',
      }),
    ]);
    expect(revisionFindMany.mock.calls[0]?.[0].where).toEqual({
      OR: [{ revision: 1, skillId: 'sk-tdd' }],
    });
  });

  it('reads the current revision when the run has no pin', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [editedSkillRef()] }));

    const r = await resolveAgent('reviewer');

    expect(r.skills[0]?.promptText).toBe('PROMPT_tdd (edited mid-run)');
    expect(revisionFindMany).not.toHaveBeenCalled();
  });

  it('uses the live row (no query) when the pin is the current revision', async () => {
    const ref = skillRef('tdd', 0);
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [ref] }));

    const r = await resolveAgent('reviewer', { skillRevisions: { 'sk-tdd': 1 } });

    expect(r.skills[0]).toMatchObject({ isVerified: true, promptText: 'PROMPT_tdd' });
    expect(revisionFindMany).not.toHaveBeenCalled();
  });

  it('resolves a skill the pin map does not name at its current revision', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [editedSkillRef()] }));

    const r = await resolveAgent('reviewer', { skillRevisions: { 'sk-other': 1 } });

    expect(r.skills[0]?.promptText).toBe('PROMPT_tdd (edited mid-run)');
  });

  it('falls back to the live text when the pinned revision row is missing, and says so', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [editedSkillRef()] }));
    revisionFindMany.mockResolvedValue([]);

    const r = await resolveAgent('reviewer', { skillRevisions: { 'sk-tdd': 1 } });

    expect(r.skills[0]?.promptText).toBe('PROMPT_tdd (edited mid-run)');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pinned skill revision missing'), {
      missing: [{ currentRevision: 3, pinnedRevision: 1, skillId: 'sk-tdd' }],
    });
    // Outside an activity there is no run to attach a trace event to.
    expect(persistTrace).not.toHaveBeenCalled();
  });

  it('also records a trace event when it happens inside an activity', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [editedSkillRef()] }));
    revisionFindMany.mockResolvedValue([]);
    inActivity.value = true;
    try {
      await resolveAgent('reviewer', { skillRevisions: { 'sk-tdd': 1 } });
    } finally {
      inActivity.value = false;
    }
    expect(persistTrace).toHaveBeenCalledTimes(1);
  });

  it('keys the cache on the skill pins so two pins never share an entry', async () => {
    agentFindFirst.mockResolvedValue(agentRow());
    cacheKeys.length = 0;
    await resolveAgent('reviewer', { skillRevisions: { 'sk-tdd': 1 } });
    await resolveAgent('reviewer', { skillRevisions: { 'sk-tdd': 2 } });
    await resolveAgent('reviewer', { skillRevisions: { 'sk-tdd': 1 } });
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
    expect(cacheKeys[0]).toBe(cacheKeys[2]);
  });
});

describe('resolveAgent — imported skill provenance', () => {
  function importedRef(source: { owner: string; repo: string } | null) {
    const ref = skillRef('ext', 0) as ReturnType<typeof skillRef> & {
      skill: Record<string, unknown>;
    };
    ref.skill.sourcePath = 'skills/ext';
    ref.skill.source = source;
    return ref;
  }

  it('labels a skill whose revision came from a source with owner/repo@sha7', async () => {
    agentFindFirst.mockResolvedValue(
      agentRow({ skillRefs: [importedRef({ owner: 'acme', repo: 'skills' })] })
    );
    revisionFindMany.mockResolvedValue([{ skillId: 'sk-ext', sourceSha: '0123456789abcdef' }]);

    const r = await resolveAgent('reviewer');

    expect(r.skills[0]?.provenance).toBe('external: acme/skills@0123456');
    expect(revisionFindMany.mock.calls[0]?.[0].where).toEqual({
      OR: [{ revision: 1, skillId: 'sk-ext' }],
    });
  });

  it('keeps the label, without the repository, once the source is deleted', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [importedRef(null)] }));
    revisionFindMany.mockResolvedValue([{ skillId: 'sk-ext', sourceSha: '0123456789abcdef' }]);

    expect((await resolveAgent('reviewer')).skills[0]?.provenance).toBe('external@0123456');
  });

  it('drops the label once a hand edit cut a revision with no source sha', async () => {
    agentFindFirst.mockResolvedValue(
      agentRow({ skillRefs: [importedRef({ owner: 'acme', repo: 'skills' })] })
    );
    revisionFindMany.mockResolvedValue([{ skillId: 'sk-ext', sourceSha: null }]);

    expect((await resolveAgent('reviewer')).skills[0]?.provenance).toBeUndefined();
  });

  it('reads the sha of the revision a run pinned, not the current one', async () => {
    const ref = importedRef({ owner: 'acme', repo: 'skills' });
    ref.skill.currentRevision = 2;
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [ref] }));
    revisionFindMany.mockImplementation(async ({ select }: { select: Record<string, boolean> }) =>
      select.sourceSha
        ? [{ skillId: 'sk-ext', sourceSha: 'aaaaaaa1111111' }]
        : [{ description: 'old', promptText: 'old text', revision: 1, skillId: 'sk-ext' }]
    );

    const r = await resolveAgent('reviewer', { skillRevisions: { 'sk-ext': 1 } });

    const shaQuery = revisionFindMany.mock.calls.find((c) => c[0].select.sourceSha)?.[0];
    expect(shaQuery.where).toEqual({ OR: [{ revision: 1, skillId: 'sk-ext' }] });
    expect(r.skills[0]).toMatchObject({ provenance: 'external: acme/skills@aaaaaaa' });
  });

  it('runs no extra query when no skill is imported', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ skillRefs: [skillRef('plain', 0)] }));

    const r = await resolveAgent('reviewer');

    expect(r.skills[0]?.provenance).toBeUndefined();
    expect(revisionFindMany).not.toHaveBeenCalled();
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

describe('resolveAgent — runtime', () => {
  it('reads the row’s own runtime, and null as no opinion', async () => {
    agentFindFirst.mockResolvedValueOnce(agentRow({ runtime: 'claude-code' }));
    expect((await resolveAgent('reviewer')).runtime).toBe('claude-code');
    agentFindFirst.mockResolvedValueOnce(agentRow());
    expect((await resolveAgent('reviewer')).runtime).toBeNull();
  });

  it('inherits the runtime along inheritsModelFrom, as the model is', async () => {
    agentFindFirst.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'ciFixer'
        ? agentRow({ inheritsModelFrom: 'implementer', key: 'ciFixer', modelSpec: null })
        : agentRow({ key: 'implementer', runtime: 'claude-code' })
    );
    const r = await resolveAgent('ciFixer');
    expect(r.runtime).toBe('claude-code');
    expect(r.model.spec).toBe('anthropic/claude-opus-4-8');
  });

  it('lets a persona’s own runtime win over its parent’s', async () => {
    agentFindFirst.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'ciFixer'
        ? agentRow({
            inheritsModelFrom: 'implementer',
            key: 'ciFixer',
            modelSpec: null,
            runtime: 'mastra',
          })
        : agentRow({ key: 'implementer', runtime: 'claude-code' })
    );
    expect((await resolveAgent('ciFixer')).runtime).toBe('mastra');
  });

  it('does not inherit from a parent when the row carries its own model', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ inheritsModelFrom: 'implementer' }));
    expect((await resolveAgent('reviewer')).runtime).toBeNull();
    expect(agentFindFirst).toHaveBeenCalledTimes(1);
  });

  it('reads an unknown runtime as no opinion, with a warning', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ runtime: 'something-else' }));
    expect((await resolveAgent('reviewer')).runtime).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'agent has an unknown runtime; ignoring it',
      expect.objectContaining({ runtime: 'something-else' })
    );
  });
});

describe('resolveAgentRuntimeChoice', () => {
  it('reads the runtime through the same cascade and chain, without a credential', async () => {
    agentFindFirst.mockImplementation(async ({ where }: { where: { key: string } }) =>
      where.key === 'ciFixer'
        ? agentRow({ inheritsModelFrom: 'implementer', key: 'ciFixer', modelSpec: null })
        : agentRow({ key: 'implementer', runtime: 'claude-code' })
    );
    expect(await resolveAgentRuntimeChoice('ciFixer', { teamId: 't' })).toBe('claude-code');
    expect(mockedResolveCred).not.toHaveBeenCalled();
    // Only the scalars the chain needs are read, not the skills.
    expect(agentFindFirst.mock.calls[0]?.[0]).toMatchObject({
      select: { inheritsModelFrom: true, key: true, modelSpec: true, runtime: true, version: true },
    });
    expect(agentFindFirst.mock.calls[0]?.[0]).not.toHaveProperty('include');
  });

  it('walks the tiers as resolveAgent does, honouring the GLOBAL version pin', async () => {
    agentFindFirst.mockResolvedValue(null);
    await resolveAgentRuntimeChoice('implementer', {
      agentVersions: { implementer: 3 },
      orgId: 'o',
      teamId: 't',
      workflowTemplateId: 'tpl',
    }).catch(() => undefined);
    expect(agentFindFirst.mock.calls.map((c) => c[0].where)).toEqual([
      { isActive: true, key: 'implementer', scope: 'WORKFLOW_TEMPLATE', workflowTemplateId: 'tpl' },
      { isActive: true, key: 'implementer', scope: 'TEAM', teamId: 't' },
      { isActive: true, key: 'implementer', orgId: 'o', scope: 'ORGANIZATION' },
      { isActive: true, key: 'implementer', scope: 'GLOBAL', version: 3 },
    ]);
  });

  it('returns null for an agent with no opinion, and throws for one that does not exist', async () => {
    agentFindFirst.mockResolvedValueOnce(agentRow());
    expect(await resolveAgentRuntimeChoice('reviewer')).toBeNull();
    agentFindFirst.mockResolvedValue(null);
    await expect(resolveAgentRuntimeChoice('ghost')).rejects.toBeInstanceOf(ConfigMissingError);
  });
});
