import type { PrismaClient } from '@auto-swe/shared';
import type { ConfigActor } from '@auto-swe/shared/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateSettingsCache: vi.fn(),
}));

import { setSetting } from './configSettingsService.js';
import { RUNTIME_WARNING_AGENT_CAP, runtimeSettingWarnings } from './runtimeSettingAdvice.js';

const ADMIN: ConfigActor = { id: 'admin-1', role: 'ADMIN' };
const GLOBAL = { scope: 'GLOBAL' } as const;

type Row = {
  inheritsModelFrom?: string | null;
  key: string;
  modelSpec?: string | null;
  runtime?: string | null;
  version?: number;
};

function makePrisma(agents: Row[]) {
  return {
    agent: {
      // Rows come back oldest version first, as a table with no ORDER BY may; only a query that
      // asks for `version desc` gets the newest first.
      findMany: vi.fn().mockImplementation(async (args: { orderBy?: unknown }) => {
        const rows = agents
          .map((a) => ({
            inheritsModelFrom: null,
            modelSpec: null,
            runtime: null,
            version: 1,
            ...a,
          }))
          .sort((a, b) => a.version - b.version);
        const wantsNewest = JSON.stringify(args.orderBy ?? null).includes('"version":"desc"');
        return wantsNewest ? rows.reverse() : rows;
      }),
    },
    configPermission: { findMany: vi.fn().mockResolvedValue([]) },
    configSetting: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}
type FakePrisma = ReturnType<typeof makePrisma>;
const asPrisma = (p: FakePrisma) => p as unknown as PrismaClient;

const MIXED: Row[] = [
  { key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5' },
  { inheritsModelFrom: 'implementer', key: 'ciFixer' },
  { key: 'contentWriter', modelSpec: 'openai/gpt-6-luna' },
  { key: 'supportResponder', modelSpec: 'openai/gpt-6-luna', runtime: 'mastra' },
  { inheritsModelFrom: 'contentWriter', key: 'brandReviewer' },
];

let prisma: FakePrisma;
beforeEach(() => {
  vi.clearAllMocks();
});

describe('runtimeSettingWarnings', () => {
  it('names the non-Anthropic agents that follow claude-code, own model or inherited', async () => {
    prisma = makePrisma(MIXED);
    const [warning] = await runtimeSettingWarnings(
      asPrisma(prisma),
      'workspace.agentRunRuntime',
      'claude-code'
    );
    expect(warning).toContain('contentWriter (openai/gpt-6-luna)');
    expect(warning).toContain('brandReviewer (openai/gpt-6-luna)');
    // An own runtime means the setting does not select its loop; Anthropic agents are fine.
    expect(warning).not.toContain('supportResponder');
    expect(warning).not.toContain('implementer');
    expect(warning).not.toContain('ciFixer');
  });

  it('limits implementerRuntime to the implementer personas, not by inheritance', async () => {
    prisma = makePrisma([
      { key: 'implementer', modelSpec: 'openai/gpt-6-luna' },
      { key: 'ciFixer', modelSpec: 'openai/gpt-6-luna' }, // own model, no parent: still covered
      { inheritsModelFrom: 'implementer', key: 'customPersona' }, // inherits, but not run by caller
      { key: 'contentWriter', modelSpec: 'openai/gpt-6-luna' },
    ]);
    const [warning] = await runtimeSettingWarnings(
      asPrisma(prisma),
      'workspace.implementerRuntime',
      'claude-code'
    );
    expect(warning).toContain('implementer (');
    expect(warning).toContain('ciFixer (');
    expect(warning).not.toContain('customPersona');
    expect(warning).not.toContain('contentWriter');
  });

  it('stops the walk at a row with its own model, so a parent runtime is not inherited', async () => {
    prisma = makePrisma([
      { key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5', runtime: 'claude-code' },
      { inheritsModelFrom: 'implementer', key: 'x', modelSpec: 'openai/gpt-6-luna' },
      // A parent without a model passes its runtime down, and the walk stops at the model.
      { key: 'base', modelSpec: 'openai/gpt-6-luna', runtime: 'pi' },
      { inheritsModelFrom: 'base', key: 'viaBase' },
    ]);
    const [warning] = await runtimeSettingWarnings(
      asPrisma(prisma),
      'workspace.agentRunRuntime',
      'claude-code'
    );
    expect(warning).toContain('x (openai/gpt-6-luna)');
    expect(warning).not.toContain('viaBase');
    expect(warning).not.toContain('base (');
  });

  it('is silent for pi and mastra, and reads nothing', async () => {
    prisma = makePrisma(MIXED);
    for (const value of ['pi', 'mastra']) {
      expect(
        await runtimeSettingWarnings(asPrisma(prisma), 'workspace.agentRunRuntime', value)
      ).toEqual([]);
    }
    expect(prisma.agent.findMany).not.toHaveBeenCalled();
  });

  it('is silent for any other key', async () => {
    prisma = makePrisma(MIXED);
    expect(await runtimeSettingWarnings(asPrisma(prisma), 'workspace.cpus', 'claude-code')).toEqual(
      []
    );
  });

  it('is silent when every agent is Anthropic', async () => {
    prisma = makePrisma([
      { key: 'implementer', modelSpec: 'anthropic/claude-opus-5-5' },
      { inheritsModelFrom: 'implementer', key: 'ciFixer' },
    ]);
    expect(
      await runtimeSettingWarnings(asPrisma(prisma), 'workspace.agentRunRuntime', 'claude-code')
    ).toEqual([]);
  });

  it('uses only the newest version of a key', async () => {
    prisma = makePrisma([
      { key: 'writer', modelSpec: 'anthropic/claude-opus-5-5', version: 2 },
      { key: 'writer', modelSpec: 'openai/gpt-6-luna', version: 1 },
    ]);
    expect(
      await runtimeSettingWarnings(asPrisma(prisma), 'workspace.agentRunRuntime', 'claude-code')
    ).toEqual([]);
  });

  it('caps the names and counts the rest', async () => {
    const total = RUNTIME_WARNING_AGENT_CAP + 3;
    prisma = makePrisma(
      Array.from({ length: total }, (_, i) => ({
        key: `agent${String(i).padStart(2, '0')}`,
        modelSpec: 'openai/gpt-6-luna',
      }))
    );
    const [warning] = await runtimeSettingWarnings(
      asPrisma(prisma),
      'workspace.agentRunRuntime',
      'claude-code'
    );
    expect(warning).toContain(`${total} platform-wide agents`);
    expect(warning).toContain('+3 more');
    expect(warning).toContain('agent00');
    expect(warning).not.toContain(`agent${String(total - 1).padStart(2, '0')} (`);
  });
});

describe('setSetting with a runtime setting', () => {
  it('saves claude-code and returns the warning', async () => {
    prisma = makePrisma(MIXED);
    const result = await setSetting(
      asPrisma(prisma),
      ADMIN,
      'workspace.agentRunRuntime',
      GLOBAL,
      'claude-code'
    );
    expect(prisma.configSetting.create).toHaveBeenCalled();
    expect(result).toMatchObject({
      after: 'claude-code',
      warnings: [expect.stringContaining('contentWriter')],
    });
  });

  it('still saves, without warnings, when the advice cannot be computed', async () => {
    prisma = makePrisma(MIXED);
    prisma.agent.findMany.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await setSetting(
      asPrisma(prisma),
      ADMIN,
      'workspace.implementerRuntime',
      GLOBAL,
      'claude-code'
    );
    expect(prisma.configSetting.create).toHaveBeenCalled();
    expect(result).toEqual({ after: 'claude-code', before: undefined });
  });

  it('adds no warning for mastra', async () => {
    prisma = makePrisma(MIXED);
    const result = await setSetting(
      asPrisma(prisma),
      ADMIN,
      'workspace.agentRunRuntime',
      GLOBAL,
      'mastra'
    );
    expect(result).toEqual({ after: 'mastra', before: undefined });
  });
});
