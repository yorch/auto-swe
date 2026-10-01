import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import type { Context } from '../workflow/expr.js';
import { type Dispatcher, runSpec } from '../workflow/interpreter.js';
import { parseWorkflowSpec } from '../workflow/spec.js';
import { validateSpec } from '../workflow/validateSpec.js';
import {
  AGENT_RUN_SPEC,
  AGENT_RUN_STEP,
  AGENT_RUN_TEMPLATE_NAME,
  AGENT_RUN_TEMPLATE_ORIGIN,
} from './agentRun.js';
import { syncAgentRunTemplate } from './syncBuiltins.js';

describe('AGENT_RUN_SPEC', () => {
  it('parses and validates, and its only step is the internal one', () => {
    const spec = parseWorkflowSpec(AGENT_RUN_SPEC);
    expect(validateSpec(spec, { allowInternalSteps: true }).errors).toEqual([]);
    // ...and is refused for anything an author could submit.
    expect(validateSpec(spec).errors.map((e) => e.code)).toEqual(['INTERNAL_STEP']);
    const steps = Object.values(spec.nodes).filter((n) => n.type === 'step');
    expect(steps.map((n) => (n as { step: string }).step)).toEqual([AGENT_RUN_STEP]);
  });

  it('is not a library template (it must not surface in the use-case catalog)', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).not.toContain(AGENT_RUN_TEMPLATE_NAME);
  });

  it('runs: one dispatch of the internal step, its output surfaced in the result', async () => {
    const calls: Array<{ step: string; inputs: Record<string, unknown> }> = [];
    const dispatcher: Dispatcher = {
      async dispatchStep({ step, inputs }) {
        calls.push({ inputs, step });
        return { branch: 'auto/agent-1', gate: 'passed', text: 'ok' };
      },
      async recordStep() {},
      async waitSignal() {
        return undefined;
      },
    };
    const ctx: Context = {
      context: {},
      nodes: {},
      request: {
        description: 'do it',
        externalTicketId: 'agent-0a1b2c3d111122223333444455556666',
        repoId: 'r',
      },
      workflow: { id: 'w' },
    };
    const result = await runSpec(parseWorkflowSpec(AGENT_RUN_SPEC), ctx, dispatcher);
    expect(result.status).toBe('SUCCESS');
    expect(calls).toEqual([{ inputs: { task: 'do it' }, step: 'runAgentTask' }]);
    expect(result.result).toMatchObject({ branch: 'auto/agent-1', gate: 'passed', text: 'ok' });
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

describe('syncAgentRunTemplate', () => {
  it('creates the template once, hidden-by-origin and active', async () => {
    const { prisma, rows } = makePrisma();
    await syncAgentRunTemplate(prisma);
    await syncAgentRunTemplate(prisma);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      activeVersion: 1,
      name: AGENT_RUN_TEMPLATE_NAME,
      origin: AGENT_RUN_TEMPLATE_ORIGIN,
      status: 'ACTIVE',
      teamId: null,
    });
    expect(rows[0]?.versions).toHaveLength(1);
  });

  it('appends and activates a new version when the built-in spec changes', async () => {
    const { prisma, rows } = makePrisma([
      {
        activeVersion: 1,
        id: 't0',
        name: AGENT_RUN_TEMPLATE_NAME,
        origin: AGENT_RUN_TEMPLATE_ORIGIN,
        status: 'ACTIVE',
        teamId: null,
        versions: [{ spec: { old: true }, version: 1 }],
      },
    ]);
    await syncAgentRunTemplate(prisma);
    expect(rows[0]?.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(rows[0]?.activeVersion).toBe(2);
  });

  it('never appends the system spec to a same-named template it does not own', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const origin of [null, 'swe-starter', 'bundle:evil']) {
      const { prisma, rows } = makePrisma([
        {
          activeVersion: 1,
          id: 'admins',
          name: AGENT_RUN_TEMPLATE_NAME,
          origin,
          status: 'ACTIVE',
          teamId: null,
          versions: [{ spec: { admin: true }, version: 1 }],
        },
      ]);
      await syncAgentRunTemplate(prisma);
      expect(rows[0]?.versions).toHaveLength(1);
      expect(rows[0]?.origin).toBe(origin);
    }
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
