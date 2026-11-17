/**
 * The gateway's plan checks against what the generator pipeline really produces.
 *
 * `runPlanService.test.ts` mocks the skeleton policy and feeds hand-made specs. Here nothing of the
 * policy is mocked: an authored free region goes through the same shared steps the worker's
 * `generateRunPlanSpec` runs on each model answer (`materializeUses` + `parseWorkflowSpec`,
 * `applySkeletonPolicy`, `checkSkeletonPolicy`, `validateSpec`, `specAgentKeys` +
 * `resolveRunPlanAgentPins`, `estimateRunPlanCost`, `runPlanCatalogHash`), and the result (spec,
 * pins, catalog hash, injected ids) is stored with `createPlanRecord` and approved with
 * `approvePlan`, so the pin keys the generator records (parents and step-reached agents included)
 * are compared with what `agentDrift` resolves at approval. The worker's own suite proves the
 * activity returns exactly this pipeline's output with a fake model; the gateway cannot import the
 * activity (each package compiles from its own `src`).
 */
import {
  type AgentPinReader,
  resolveRunPlanAgentPins,
  specAgentKeys,
} from '@auto-swe/shared/lib/runPlanAgentPins';
import {
  applySkeletonPolicy,
  checkSkeletonPolicy,
  materializeUses,
  parseWorkflowSpec,
  validateSpec,
} from '@auto-swe/shared/workflow';
import { runPlanCatalogHash } from '@auto-swe/shared/workflow/runPlan';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ settings: { value: { 'workflow.maxTransitions': 500 } } }));

vi.mock('@auto-swe/shared/config', async (original) => ({
  ...(await original<object>()),
  snapshotPinnedSettings: vi.fn(async () => m.settings.value),
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./runConnection.js', () => ({ validateRunConnection: vi.fn(async () => ({ ok: true })) }));

import { approvePlan, createPlanRecord, type RunPlanServiceDeps } from './runPlanService.js';

const OWNER = { sub: 'user-1' };
const NOW = new Date('2026-11-17T12:00:00Z');

const AUTHORED = {
  description: 'Survey, then implement.',
  entry: 'survey',
  name: 'Survey then implement',
  nodes: {
    handover: { status: 'SUCCESS', type: 'terminate' },
    survey: {
      agentRef: 'planner',
      next: 'handover',
      status: 'PLANNING',
      storeAs: 'context.planNotes',
      type: 'agent',
      userMessage: 'Outline the files and risks involved.',
    },
  },
  schemaVersion: 1,
};

/** Run the worker's accept steps over an authored spec, with a stand-in agent table. */
async function generate(authored: unknown, versions: Map<string, number>) {
  const parsed = parseWorkflowSpec(materializeUses(authored));
  const applied = applySkeletonPolicy(parsed, 'delivering');
  expect(applied.report.errors).toEqual([]);
  const spec = applied.spec;
  expect(checkSkeletonPolicy(spec, 'delivering').errors).toEqual([]);
  expect(validateSpec(spec, { allowInternalSteps: false }).errors).toEqual([]);
  const pins = await resolveRunPlanAgentPins(reader(versions), specAgentKeys(spec), {
    orgId: 'org-1',
    teamId: 'team-1',
    workflowTemplateId: 'tpl-planned',
  });
  expect(Object.values(pins).every((p) => p !== null)).toBe(true);
  return { agentPins: pins as Record<string, string>, injected: applied.injected, spec };
}

/** Every agent key resolves at GLOBAL to a version from `versions` (default 1). */
function reader(versions: Map<string, number>): AgentPinReader {
  return {
    agent: {
      findFirst: async ({ where }) =>
        where.scope === 'GLOBAL'
          ? {
              inheritsModelFrom: null,
              modelSpec: 'x',
              scope: 'GLOBAL',
              version: versions.get(String(where.key)) ?? 1,
            }
          : null,
    },
  };
}

function store(versions: Map<string, number>, launchable: string[]) {
  const table: { plan: Record<string, unknown> | null } = { plan: null };
  const prisma = {
    agent: {
      findFirst: reader(versions).agent.findFirst,
      findMany: vi.fn(async () => launchable.map((key) => ({ key }))),
    },
    connection: {
      findUnique: vi.fn(async () => ({
        githubApiUrl: null,
        githubUrl: null,
        id: 'repo-1',
        organizationName: 'acme',
        repoName: 'api',
        team: { orgId: 'org-1' },
        teamId: 'team-1',
        type: 'git_repo',
      })),
    },
    runPlan: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        table.plan = { id: 'plan-1', ...data };
        return { expiresAt: data.expiresAt, id: 'plan-1' };
      }),
      findUnique: vi.fn(async () => (table.plan ? { ...table.plan } : null)),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(table.plan ?? {}, data);
        return { count: 1 };
      }),
    },
    user: { findUnique: vi.fn(async () => ({ id: OWNER.sub, isActive: true, role: 'ENGINEER' })) },
    workflowTemplate: { findFirst: vi.fn(async () => ({ activeVersion: 1, id: 'tpl-planned' })) },
  };
  const deps = { now: () => NOW, prisma: prisma as never } as RunPlanServiceDeps;
  return { deps, table };
}

let versions: Map<string, number>;
beforeEach(() => {
  versions = new Map();
});

async function createFromGenerator(deps: RunPlanServiceDeps) {
  const generated = await generate(AUTHORED, versions);
  const result = await createPlanRecord(deps, {
    agentPins: generated.agentPins,
    catalogHash: runPlanCatalogHash(),
    connectionId: 'repo-1',
    intent: 'Survey the retry code, then add backoff.',
    mode: 'delivering',
    model: 'anthropic/claude-sonnet-5-5',
    owner: OWNER,
    routerCandidates: { injected: generated.injected },
    settingsSnapshot: m.settings.value,
    spec: generated.spec,
    summary: 'Surveys retries, then implements backoff.',
  });
  return { generated, result };
}

describe('a plan the generator pipeline produced', () => {
  it('is stored by createPlanRecord and approved by approvePlan with no drift', async () => {
    const { deps, table } = store(versions, ['planner']);
    const { generated, result } = await createFromGenerator(deps);
    expect(result).toMatchObject({ ok: true });
    // The core's step agents are in the pins the generator recorded, so nothing is "missing".
    expect(Object.keys(generated.agentPins)).toEqual(expect.arrayContaining(['implementer']));
    expect(table.plan?.agentPins).toEqual(generated.agentPins);
    expect(await approvePlan(deps, OWNER, 'plan-1')).toMatchObject({ ok: true });
    expect(table.plan?.status).toBe('APPROVED');
  });

  it('is refused at approval when an agent it pins is bumped afterwards', async () => {
    const { deps, table } = store(versions, ['planner']);
    expect(await createFromGenerator(deps)).toMatchObject({ result: { ok: true } });
    versions.set('implementer', 9);
    expect(await approvePlan(deps, OWNER, 'plan-1')).toMatchObject({
      code: 'PLAN_AGENTS_CHANGED',
      ok: false,
    });
    expect(table.plan?.status).not.toBe('APPROVED');
  });

  it('is refused at approval when its agent node can no longer be launched', async () => {
    const { deps, table } = store(versions, ['planner']);
    expect(await createFromGenerator(deps)).toMatchObject({ result: { ok: true } });
    // Same table, but the organization no longer offers `planner`.
    (deps.prisma as unknown as { agent: { findMany: unknown } }).agent.findMany = vi.fn(
      async () => []
    );
    expect(await approvePlan(deps, OWNER, 'plan-1')).toMatchObject({
      code: 'PLAN_AGENT_NOT_LAUNCHABLE',
      ok: false,
    });
    expect(table.plan?.status).not.toBe('APPROVED');
  });

  it('is refused at creation when the generator named an agent the gateway cannot launch', async () => {
    const { deps, table } = store(versions, []);
    expect(await createFromGenerator(deps)).toMatchObject({
      result: { code: 'PLAN_AGENT_NOT_LAUNCHABLE', ok: false },
    });
    expect(table.plan).toBeNull();
  });
});
