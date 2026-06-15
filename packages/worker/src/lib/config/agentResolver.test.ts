import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentFindFirst, credentialFindUnique } = vi.hoisted(() => ({
  agentFindFirst: vi.fn(),
  credentialFindUnique: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agent: { findFirst: agentFindFirst },
    providerCredential: { findUnique: credentialFindUnique },
  },
}));

// Pass-through cache so resolution isn't memoized across cases.
vi.mock('./cache.js', () => ({
  configCacheTtlMs: () => 0,
  withCache: (_k: string, _t: number, fn: () => unknown) => fn(),
}));

vi.mock('./resolver.js', () => ({
  resolveModelConfig: vi.fn(),
  resolveProviderCredential: vi.fn(),
}));

vi.mock('./agentSkills.js', () => ({
  loadAgentSkills: vi.fn(),
  loadAgentToolConfig: vi.fn(),
}));

vi.mock('../providerUtils.js', () => ({
  parseProviderModelSpec: (spec: string) => ({
    modelId: spec.split('/')[1] ?? '',
    provider: spec.split('/')[0] ?? '',
  }),
}));

import { resolveAgent } from './agentResolver.js';
import { loadAgentSkills, loadAgentToolConfig } from './agentSkills.js';
import { resolveModelConfig, resolveProviderCredential } from './resolver.js';

const mockedResolveModelConfig = vi.mocked(resolveModelConfig);
const mockedLoadSkills = vi.mocked(loadAgentSkills);
const mockedLoadTools = vi.mocked(loadAgentToolConfig);
const mockedResolveCred = vi.mocked(resolveProviderCredential);

const legacyModel = {
  apiBase: undefined,
  apiKey: 'legacy-key',
  scope: 'GLOBAL' as const,
  spec: 'anthropic/legacy',
  systemPrompt: 'LEGACY_PROMPT' as string | undefined,
};
const legacySkill = {
  description: 'd',
  id: 'sk-legacy',
  isVerified: true,
  name: 'legacy',
  promptText: 'LEGACY_SKILL',
  sortOrder: 0,
};

// biome-ignore lint/suspicious/noExplicitAny: test row factory
function agentRow(overrides: Record<string, any> = {}) {
  return {
    credentialId: null,
    isActive: true,
    isVerified: true,
    key: 'reviewer',
    modelSpec: null,
    origin: 'swe-starter',
    scope: 'GLOBAL',
    skillRefs: [],
    systemPrompt: null,
    toolKeys: null,
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  agentFindFirst.mockResolvedValue(null);
  mockedResolveModelConfig.mockResolvedValue({ ...legacyModel });
  mockedLoadSkills.mockResolvedValue([{ ...legacySkill }]);
  mockedLoadTools.mockResolvedValue(['readFile']);
});

describe('resolveAgent — parity with the legacy cascade', () => {
  it('with no Agent row, returns exactly the legacy model/skills/tools', async () => {
    const r = await resolveAgent('reviewer', { teamId: 't1' });

    expect(r.model).toEqual(legacyModel);
    expect(r.skills).toEqual([legacySkill]);
    expect(r.toolKeys).toEqual(['readFile']);
    expect(r.version).toBe(1);
    expect(r.isVerified).toBe(true);
    expect(r.origin).toBeNull();
    // Each legacy resolver consulted with the same key + ctx.
    expect(mockedResolveModelConfig).toHaveBeenCalledWith('reviewer', { teamId: 't1' });
    expect(mockedLoadSkills).toHaveBeenCalledWith('reviewer', { teamId: 't1' });
    expect(mockedLoadTools).toHaveBeenCalledWith('reviewer', { teamId: 't1' });
  });

  it('with a null-override Agent row (seeded SWE agent), still equals legacy', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ origin: 'swe-starter', version: 3 }));

    const r = await resolveAgent('reviewer');

    expect(r.model).toEqual(legacyModel);
    expect(r.skills).toEqual([legacySkill]);
    expect(r.toolKeys).toEqual(['readFile']);
    // Identity comes from the row.
    expect(r.version).toBe(3);
    expect(r.origin).toBe('swe-starter');
  });
});

describe('resolveAgent — overrides', () => {
  it('applies a systemPrompt override over the legacy base prompt', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ systemPrompt: 'AGENT_PROMPT' }));
    const r = await resolveAgent('reviewer');
    expect(r.model.systemPrompt).toBe('AGENT_PROMPT');
    expect(r.model.spec).toBe('anthropic/legacy');
  });

  it('uses skillRefs instead of the legacy skill cascade when present', async () => {
    agentFindFirst.mockResolvedValue(
      agentRow({
        skillRefs: [
          {
            skill: {
              description: 'rd',
              id: 'sk-1',
              isVerified: false,
              name: 'ref',
              promptText: 'REF',
            },
            sortOrder: 5,
          },
        ],
      })
    );
    const r = await resolveAgent('reviewer');
    expect(r.skills).toEqual([
      {
        description: 'rd',
        id: 'sk-1',
        isVerified: false,
        name: 'ref',
        promptText: 'REF',
        sortOrder: 5,
      },
    ]);
    expect(mockedLoadSkills).not.toHaveBeenCalled();
  });

  it('uses a toolKeys override (including explicit empty) instead of the legacy tool config', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ toolKeys: ['bash'] }));
    const r1 = await resolveAgent('reviewer');
    expect(r1.toolKeys).toEqual(['bash']);
    expect(mockedLoadTools).not.toHaveBeenCalled();

    vi.clearAllMocks();
    agentFindFirst.mockResolvedValue(agentRow({ toolKeys: [] }));
    const r2 = await resolveAgent('reviewer');
    expect(r2.toolKeys).toEqual([]);
    expect(mockedLoadTools).not.toHaveBeenCalled();
  });

  it('resolves the credential from the provider cascade when modelSpec is overridden', async () => {
    agentFindFirst.mockResolvedValue(agentRow({ modelSpec: 'openai/gpt-x', systemPrompt: 'P' }));
    mockedResolveCred.mockResolvedValue({ apiBase: undefined, apiKey: 'openai-key' });

    const r = await resolveAgent('reviewer');

    expect(r.model).toEqual({
      apiBase: undefined,
      apiKey: 'openai-key',
      scope: 'GLOBAL',
      spec: 'openai/gpt-x',
      systemPrompt: 'P',
    });
    expect(mockedResolveModelConfig).not.toHaveBeenCalled();
    expect(mockedResolveCred).toHaveBeenCalledWith('openai', undefined);
  });
});

describe('resolveAgent — model inheritance', () => {
  it('binds the parent role model via inheritsModelFrom when modelSpec is null', async () => {
    agentFindFirst.mockResolvedValue(
      agentRow({ inheritsModelFrom: 'reviewer', key: 'securityReviewer', modelSpec: null })
    );

    const r = await resolveAgent('securityReviewer');

    // Model resolved from the PARENT key, not the sub-role's own (missing) row.
    expect(mockedResolveModelConfig).toHaveBeenCalledWith('reviewer', undefined);
    expect(r.model).toEqual(legacyModel);
  });
});

describe('resolveAgent — run-start version pin (WS3)', () => {
  it('queries the pinned version from ctx.agentVersions instead of the latest', async () => {
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

  it('does not pin when the key is absent from the snapshot', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    let capturedWhere: any;
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      capturedWhere = args.where;
      return agentRow();
    });

    await resolveAgent('reviewer', { agentVersions: { other: 5 } });

    expect(capturedWhere.version).toBeUndefined();
  });
});

describe('resolveAgent — scope cascade', () => {
  it('prefers a TEAM Agent row over GLOBAL', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: arg inspection
    agentFindFirst.mockImplementation(async (args: any) => {
      if (args.where.scope === 'TEAM') {
        return agentRow({ scope: 'TEAM', version: 7 });
      }
      return agentRow({ scope: 'GLOBAL', version: 1 });
    });

    const r = await resolveAgent('reviewer', { teamId: 't1' });
    expect(r.version).toBe(7);
  });
});
