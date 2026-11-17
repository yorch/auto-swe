import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import { type Dispatcher, runSpec } from '../workflow/interpreter.js';
import { hashRunPlanSpec, runPlanCatalogHash } from '../workflow/runPlan/index.js';
import { parseWorkflowSpec } from '../workflow/spec.js';
import { validateSpec } from '../workflow/validateSpec.js';
import {
  isReservedTemplateName,
  isReservedTemplateOrigin,
  RESERVED_TEMPLATE_NAMES,
} from './agentRun.js';
import {
  isPlannedRunTemplate,
  PLANNED_RUN_SPEC,
  PLANNED_RUN_TEMPLATE_NAME,
  PLANNED_RUN_TEMPLATE_ORIGIN,
  PlannedRunPayloadSchema,
  plannedRunTicketId,
} from './plannedRun.js';
import {
  type AgentPinReader,
  agentPinDrift,
  resolveRunPlanAgentPins,
  specAgentKeys,
} from './runPlanAgentPins.js';
import { syncPlannedRunTemplate } from './syncBuiltins.js';

describe('PLANNED_RUN_SPEC', () => {
  it('parses and validates as an ordinary spec: it needs no internal step', () => {
    const spec = parseWorkflowSpec(PLANNED_RUN_SPEC);
    expect(validateSpec(spec).errors).toEqual([]);
  });

  it('is not a library template (it must not surface in the use-case catalog)', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).not.toContain(PLANNED_RUN_TEMPLATE_NAME);
  });

  it('fails when run as it stands, so a skipped pin can never run something else', async () => {
    const dispatcher: Dispatcher = {
      dispatchStep: vi.fn(),
      async recordStep() {},
      async waitSignal() {
        return undefined;
      },
    };
    const result = await runSpec(
      parseWorkflowSpec(PLANNED_RUN_SPEC),
      {
        context: {},
        nodes: {},
        request: { description: 'x', externalTicketId: 'plan-1', repoId: 'r' },
        workflow: { id: 'w' },
      },
      dispatcher
    );
    expect(result.status).toBe('FAILED');
    expect(dispatcher.dispatchStep).not.toHaveBeenCalled();
  });
});

describe('the reserved names and origin', () => {
  it('reserves both system templates, in any casing', () => {
    expect(RESERVED_TEMPLATE_NAMES).toEqual(['Agent Run', 'Planned Run']);
    for (const name of ['Planned Run', 'planned run', '  PLANNED RUN ', 'Agent Run']) {
      expect(isReservedTemplateName(name)).toBe(true);
    }
    expect(isReservedTemplateName('Planned Run 2')).toBe(false);
  });

  it('treats the origin as a system: origin, so every existing guard hides it', () => {
    expect(isReservedTemplateOrigin(PLANNED_RUN_TEMPLATE_ORIGIN)).toBe(true);
  });

  it('recognises the template only with the reserved origin and no owning team', () => {
    expect(isPlannedRunTemplate({ origin: PLANNED_RUN_TEMPLATE_ORIGIN, teamId: null })).toBe(true);
    expect(isPlannedRunTemplate({ origin: PLANNED_RUN_TEMPLATE_ORIGIN, team: null })).toBe(true);
    expect(isPlannedRunTemplate({ origin: PLANNED_RUN_TEMPLATE_ORIGIN, teamId: 't' })).toBe(false);
    expect(isPlannedRunTemplate({ origin: PLANNED_RUN_TEMPLATE_ORIGIN, team: {} })).toBe(false);
    expect(isPlannedRunTemplate({ origin: 'system:agent-run', teamId: null })).toBe(false);
    expect(isPlannedRunTemplate({ origin: null, teamId: null })).toBe(false);
  });
});

describe('PlannedRunPayloadSchema', () => {
  it('carries exactly a plan id', () => {
    const id = '0b1c2d3e-0000-4000-8000-000000000001';
    expect(PlannedRunPayloadSchema.parse({ planId: id })).toEqual({ planId: id });
    expect(PlannedRunPayloadSchema.safeParse({ planId: 'nope' }).success).toBe(false);
    expect(PlannedRunPayloadSchema.safeParse({ planId: id, spec: {} }).success).toBe(false);
    expect(PlannedRunPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('derives a synthetic ticket from the whole plan id', () => {
    expect(plannedRunTicketId('0b1c2d3e-0000-4000-8000-000000000001')).toBe(
      'plan-0b1c2d3e000040008000000000000001'
    );
  });
});

interface TplRow {
  id: string;
  name: string;
  teamId: string | null;
  origin: string | null;
  status: string;
  activeVersion: number | null;
  versions: Array<{ version: number; spec: unknown }>;
}

function makePrisma(seed: TplRow[] = []) {
  const rows = seed.map((r) => ({ ...r, versions: [...r.versions] }));
  const prisma = {
    workflowTemplate: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const { versions, ...rest } = data as {
          versions: { create: { spec: unknown; version: number } };
        };
        rows.push({
          ...(rest as unknown as TplRow),
          id: `t${rows.length}`,
          versions: [versions.create],
        });
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { name: string; teamId: null } }) =>
          rows.find((r) => r.name === where.name && r.teamId === where.teamId) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Partial<TplRow>; where: { id: string } }) => {
        Object.assign(rows.find((r) => r.id === where.id) as TplRow, data);
      }),
    },
    workflowTemplateVersion: {
      create: vi.fn(
        async ({ data }: { data: { spec: unknown; templateId: string; version: number } }) => {
          rows.find((r) => r.id === data.templateId)?.versions.push(data);
        }
      ),
      findFirst: vi.fn(async ({ where }: { where: { templateId: string } }) => {
        const v = rows.find((r) => r.id === where.templateId)?.versions;
        return v?.at(-1) ?? null;
      }),
    },
  } as unknown as PrismaClient;
  return { prisma, rows };
}

describe('syncPlannedRunTemplate', () => {
  it('creates the template once, hidden by origin, global and active', async () => {
    const { prisma, rows } = makePrisma();
    await syncPlannedRunTemplate(prisma);
    await syncPlannedRunTemplate(prisma);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      activeVersion: 1,
      name: PLANNED_RUN_TEMPLATE_NAME,
      origin: PLANNED_RUN_TEMPLATE_ORIGIN,
      status: 'ACTIVE',
      teamId: null,
    });
  });

  it('never appends the placeholder spec to a same-named template it does not own, and fails loudly', async () => {
    for (const origin of [null, 'swe-starter', 'bundle:evil', 'system:agent-run']) {
      const { prisma, rows } = makePrisma([
        {
          activeVersion: 1,
          id: 'admins',
          name: PLANNED_RUN_TEMPLATE_NAME,
          origin,
          status: 'ACTIVE',
          teamId: null,
          versions: [{ spec: { admin: true }, version: 1 }],
        },
      ]);
      await expect(syncPlannedRunTemplate(prisma)).rejects.toThrow(
        new RegExp(`'${PLANNED_RUN_TEMPLATE_NAME}'.*Rename or delete`)
      );
      expect(rows[0]?.versions).toHaveLength(1);
      expect(rows[0]?.origin).toBe(origin);
    }
  });
});

describe('hashRunPlanSpec', () => {
  it('ignores key order and undefined, and moves with any change', () => {
    const a = { entry: 'x', nodes: { x: { status: 'SUCCESS', type: 'terminate' } } };
    const reordered = {
      entry: 'x',
      nodes: { x: { gone: undefined, status: 'SUCCESS', type: 'terminate' } },
    };
    expect(hashRunPlanSpec(reordered)).toBe(hashRunPlanSpec(a));
    expect(hashRunPlanSpec({ ...a, entry: 'y' })).not.toBe(hashRunPlanSpec(a));
    expect(hashRunPlanSpec(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a spec the same before and after a JSON round trip', () => {
    const spec = parseWorkflowSpec(PLANNED_RUN_SPEC);
    expect(hashRunPlanSpec(JSON.parse(JSON.stringify(spec)))).toBe(hashRunPlanSpec(spec));
  });
});

describe('runPlanCatalogHash', () => {
  it('is stable across calls', () => {
    expect(runPlanCatalogHash()).toBe(runPlanCatalogHash());
    expect(runPlanCatalogHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('run plan agent pins', () => {
  function reader(rows: Array<{ key: string; scope: string; version: number; teamId?: string }>) {
    const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const hits = rows
        .filter(
          (r) =>
            r.key === where.key &&
            r.scope === where.scope &&
            (where.scope !== 'TEAM' || r.teamId === where.teamId)
        )
        .sort((a, b) => b.version - a.version);
      return hits[0] ? { scope: hits[0].scope, version: hits[0].version } : null;
    });
    return { agent: { findFirst } } as unknown as AgentPinReader;
  }

  it('pins the winning scope and its highest version, per key', async () => {
    const db = reader([
      { key: 'implementer', scope: 'GLOBAL', version: 2 },
      { key: 'implementer', scope: 'GLOBAL', version: 3 },
      { key: 'reviewer', scope: 'GLOBAL', version: 1 },
      { key: 'reviewer', scope: 'TEAM', teamId: 'team-1', version: 4 },
    ]);
    expect(
      await resolveRunPlanAgentPins(db, ['reviewer', 'implementer', 'ghost'], { teamId: 'team-1' })
    ).toEqual({ ghost: null, implementer: 'GLOBAL:3', reviewer: 'TEAM:4' });
  });

  it('reports a version bump, a new override, a vanished agent and a key the plan forgot', () => {
    const recorded = { implementer: 'GLOBAL:3', planner: 'GLOBAL:1', reviewer: 'GLOBAL:1' };
    const current = {
      implementer: 'GLOBAL:4',
      planner: null,
      reviewer: 'TEAM:2',
      writer: 'GLOBAL:1',
    };
    expect(agentPinDrift(recorded, current, ['writer'])).toEqual([
      'implementer',
      'planner',
      'reviewer',
      'writer',
    ]);
    expect(agentPinDrift(recorded, { ...recorded })).toEqual([]);
    expect(agentPinDrift('not an object', {})).toEqual([]);
  });

  it('lists the agent refs a spec names as written, and the agents its steps resolve', () => {
    expect(
      specAgentKeys({
        nodes: {
          a: { agentRef: 'planner', type: 'agent' },
          b: { agentRef: 'writer@3', type: 'agent' },
          c: { step: 'runTests', type: 'step' },
          d: { step: 'validateContext', type: 'step' },
        },
      })
      // `writer@3` keeps its version: the pin must check the version the node runs.
    ).toEqual(['planner', 'validateContext', 'writer@3']);
  });
});
