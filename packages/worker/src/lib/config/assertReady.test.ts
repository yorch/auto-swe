import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  credFindFirst,
  embedFindUnique,
  resolveAgentMock,
  slackChannelCount,
  templateFindMany,
  versionFindMany,
} = vi.hoisted(() => ({
  credFindFirst: vi.fn(),
  embedFindUnique: vi.fn(),
  resolveAgentMock: vi.fn(),
  slackChannelCount: vi.fn(),
  templateFindMany: vi.fn(),
  versionFindMany: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    embeddingConfig: { findUnique: embedFindUnique },
    providerCredential: { findFirst: credFindFirst },
    slackChannel: { count: slackChannelCount },
    workflowTemplate: { findMany: templateFindMany },
    workflowTemplateVersion: { findMany: versionFindMany },
  },
}));

// Per-agent readiness now goes through resolveAgent (the Agent entity is the
// single source of truth, P1.5). The embedding check still reads prisma directly.
vi.mock('./agentResolver.js', () => ({ resolveAgent: resolveAgentMock }));

import { assertConfigReady } from './assertReady.js';
import { installedStepNames, requiredAgentKeysForDeployment } from './deploymentAgents.js';
import { STEP_REQUIRED_AGENTS } from './stepRequiredAgents.js';

/** A spec whose step nodes between them need every model-backed agent. */
function specWithAllSweSteps() {
  const steps = [
    'validateContext',
    'executeImplementation',
    'runReviewNetwork',
    'planDecomposition',
    'commitToMemory',
    'planChannelTask',
  ];
  return {
    nodes: Object.fromEntries(steps.map((step, i) => [`n${i}`, { step, type: 'step' }])),
  };
}

/** Default: one ACTIVE template installed whose spec reaches every agent. */
function installTemplates(specs: unknown[] = [specWithAllSweSteps()]) {
  templateFindMany.mockResolvedValue(
    specs.map((_, i) => ({ activeVersion: 1, experimentVersion: null, id: `t${i}` }))
  );
  versionFindMany.mockResolvedValue(specs.map((spec) => ({ spec })));
}

const ALL_MODEL_BACKED_AGENT_KEYS = [
  'implementer',
  'reviewer',
  'planner',
  'securityReview',
  'validateContext',
  'commitToMemory',
  // General-route channel-task decomposition steps require the channel agent.
  'channelAssistant',
];

beforeEach(() => {
  resolveAgentMock.mockReset();
  credFindFirst.mockReset();
  embedFindUnique.mockReset();
  templateFindMany.mockReset();
  versionFindMany.mockReset();
  slackChannelCount.mockReset();
  slackChannelCount.mockResolvedValue(0);
  installTemplates();
});

/** Every required Agent resolves, and the embedding singleton is healthy. */
function fullyConfigured() {
  resolveAgentMock.mockResolvedValue({ key: 'x', model: { spec: 'anthropic/x' } });
  credFindFirst.mockImplementation(async () => ({ id: 'c1' }));
  embedFindUnique.mockResolvedValue({
    credential: null,
    modelSpec: 'openai/text-embedding-3-large',
  });
}

describe('STEP_REQUIRED_AGENTS', () => {
  it('reaches every model-backed agent key from some step', () => {
    // Completeness check on the catalog, not the boot gate — the gate is
    // `requiredAgentKeysForDeployment`, which is scoped to installed templates.
    const all = [...new Set(Object.values(STEP_REQUIRED_AGENTS).flat())];
    expect(all.sort()).toEqual([...ALL_MODEL_BACKED_AGENT_KEYS].sort());
  });
});

describe('requiredAgentKeysForDeployment', () => {
  it('requires only the agents the installed templates can reach', async () => {
    installTemplates([
      {
        nodes: {
          a: { step: 'runLint', type: 'step' },
          b: { status: 'SUCCESS', type: 'terminate' },
        },
      },
    ]);

    const keys = await requiredAgentKeysForDeployment();

    // runLint resolves no model, so a lint-only deployment needs no agent at
    // all — it certainly does not need `implementer`.
    expect(keys).toEqual([]);
  });

  it('requires the SWE agents when a SWE template is installed', async () => {
    const keys = await requiredAgentKeysForDeployment();
    expect([...keys].sort()).toEqual([...ALL_MODEL_BACKED_AGENT_KEYS].sort());
  });

  it('counts the experiment arm of an A/B split as installed', async () => {
    templateFindMany.mockResolvedValue([{ activeVersion: 1, experimentVersion: 2, id: 't0' }]);
    versionFindMany.mockResolvedValue([
      { spec: { nodes: { a: { step: 'runLint', type: 'step' } } } },
      { spec: { nodes: { a: { step: 'executeImplementation', type: 'step' } } } },
    ]);

    const keys = await requiredAgentKeysForDeployment();

    // Either arm can serve a run, so the experiment arm's agents are required.
    expect(keys).toContain('implementer');
  });

  it('ignores DRAFT and ARCHIVED templates', async () => {
    await requiredAgentKeysForDeployment();
    expect(templateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'ACTIVE' } })
    );
  });

  it('requires channelAssistant when a Slack channel exists, even with no step for it', async () => {
    installTemplates([{ nodes: { a: { step: 'runLint', type: 'step' } } }]);
    slackChannelCount.mockResolvedValue(1);

    const keys = await requiredAgentKeysForDeployment();

    // Channel turns call runAgent directly rather than through a step node, so
    // no spec walk can see this requirement.
    expect(keys).toEqual(['channelAssistant']);
  });

  it('requires nothing when nothing runnable is installed', async () => {
    templateFindMany.mockResolvedValue([]);
    versionFindMany.mockResolvedValue([]);

    await expect(requiredAgentKeysForDeployment()).resolves.toEqual([]);
  });

  it('skips the version query entirely when no template is active', async () => {
    templateFindMany.mockResolvedValue([]);
    await installedStepNames();
    expect(versionFindMany).not.toHaveBeenCalled();
  });

  it('tolerates a version row with a malformed spec', async () => {
    templateFindMany.mockResolvedValue([{ activeVersion: 1, experimentVersion: null, id: 't0' }]);
    versionFindMany.mockResolvedValue([{ spec: null }, { spec: { nodes: null } }]);

    await expect(installedStepNames()).resolves.toEqual(new Set());
  });
});

describe('assertConfigReady', () => {
  it('passes when every required Agent resolves and the embedding is healthy', async () => {
    fullyConfigured();
    await expect(assertConfigReady()).resolves.toBeUndefined();
    expect(resolveAgentMock).toHaveBeenCalledTimes(ALL_MODEL_BACKED_AGENT_KEYS.length);
  });

  it('reports every Agent that fails to resolve in a single error', async () => {
    resolveAgentMock.mockRejectedValue(new Error('No active Agent found'));
    embedFindUnique.mockResolvedValue({
      credential: null,
      modelSpec: 'openai/text-embedding-3-large',
    });
    credFindFirst.mockResolvedValue({ id: 'c1' });

    const err = await assertConfigReady().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    for (const role of ALL_MODEL_BACKED_AGENT_KEYS) {
      expect(err.message).toContain(role);
    }
  });

  it('surfaces a resolveAgent credential failure for a role', async () => {
    resolveAgentMock.mockImplementation(async (key: string) => {
      if (key === 'implementer') {
        throw new Error("No ProviderCredential for provider 'opencodego'");
      }
      return { key, model: { spec: 'anthropic/x' } };
    });
    credFindFirst.mockResolvedValue({ id: 'c1' });
    embedFindUnique.mockResolvedValue({
      credential: null,
      modelSpec: 'openai/text-embedding-3-large',
    });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain("ProviderCredential for provider 'opencodego'");
  });

  it('rejects an EmbeddingConfig pin whose provider does not match the spec', async () => {
    fullyConfigured();
    embedFindUnique.mockResolvedValue({
      credential: { provider: 'anthropic' },
      modelSpec: 'openai/text-embedding-3-large',
    });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('EmbeddingConfig');
    expect(err.message).toContain("pins a credential for a different provider 'anthropic'");
  });

  it('reports missing EmbeddingConfig row', async () => {
    fullyConfigured();
    embedFindUnique.mockResolvedValue(null);

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('EmbeddingConfig');
  });

  it('reports invalid modelSpec on the embedding row', async () => {
    fullyConfigured();
    embedFindUnique.mockResolvedValue({ credential: null, modelSpec: 'no-slash' });

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('invalid modelSpec');
  });

  it('rolls up multiple missing pieces into one bootstrap message', async () => {
    resolveAgentMock.mockRejectedValue(new Error('No active Agent found'));
    credFindFirst.mockResolvedValue(null);
    embedFindUnique.mockResolvedValue(null);

    const err = await assertConfigReady().catch((e) => e);
    expect(err.message).toContain('LLM configuration incomplete');
    expect(err.message).toContain('docs/model-configuration.md');
  });
});
