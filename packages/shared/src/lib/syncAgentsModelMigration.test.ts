import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { seedSweStarter } from './syncBuiltins.js';

/**
 * Upgrade path for the seeded model defaults: a GLOBAL built-in Agent still on
 * the previous default is moved to the current one by cutting a NEW version
 * (the pinned version an in-flight run resolves is never rewritten); a value an
 * admin chose is left alone; and a second sync changes nothing.
 */

interface AgentRecord {
  id: string;
  key: string;
  scope: string;
  teamId: string | null;
  orgId: string | null;
  channelId: string | null;
  workflowTemplateId: string | null;
  version: number;
  name: string;
  description: string | null;
  modelSpec: string | null;
  systemPrompt: string | null;
  inheritsModelFrom: string | null;
  credentialId: string | null;
  mcpConnectionId: string | null;
  toolKeys: unknown;
  origin: string | null;
  isBuiltIn: boolean;
  isVerified: boolean;
  isActive: boolean;
}

interface RefRecord {
  agentId: string;
  skillId: string;
  sortOrder: number;
}

function seededRow(overrides: Partial<AgentRecord> & { key: string }): AgentRecord {
  return {
    channelId: null,
    credentialId: 'cred-1',
    description: 'seeded',
    id: `${overrides.key}-v${overrides.version ?? 1}`,
    inheritsModelFrom: null,
    isActive: true,
    isBuiltIn: true,
    isVerified: true,
    mcpConnectionId: null,
    modelSpec: null,
    name: overrides.key,
    orgId: null,
    origin: 'swe-starter',
    scope: 'GLOBAL',
    systemPrompt: 'existing prompt',
    teamId: null,
    toolKeys: ['readFile', 'bash'],
    version: 1,
    workflowTemplateId: null,
    ...overrides,
  };
}

function makeStore(initialAgents: AgentRecord[], initialRefs: RefRecord[] = []) {
  const agents = [...initialAgents];
  const refs = [...initialRefs];
  let nextId = 0;

  const matches = (row: AgentRecord, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k as keyof AgentRecord] === v);

  const agent = {
    create: vi.fn(async ({ data }: { data: Partial<AgentRecord> }) => {
      nextId += 1;
      const row = seededRow({
        credentialId: null,
        description: null,
        isVerified: false,
        mcpConnectionId: null,
        systemPrompt: null,
        toolKeys: null,
        ...data,
        id: `created-${nextId}`,
        key: data.key as string,
      });
      agents.push(row);
      return row;
    }),
    findFirst: vi.fn(
      async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
        const found = agents.filter((a) => matches(a, where));
        if (orderBy) {
          found.sort((a, b) => b.version - a.version);
        }
        return found[0] ?? null;
      }
    ),
    update: vi.fn(
      async ({ data, where }: { data: Partial<AgentRecord>; where: { id: string } }) => {
        const row = agents.find((a) => a.id === where.id) as AgentRecord;
        Object.assign(row, data);
        return row;
      }
    ),
  };
  const agentSkillRef = {
    create: vi.fn(async ({ data }: { data: RefRecord }) => {
      refs.push(data);
      return data;
    }),
    createMany: vi.fn(async ({ data }: { data: RefRecord[] }) => {
      refs.push(...data);
      return { count: data.length };
    }),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async ({ where }: { where: { agentId: string } }) =>
      refs
        .filter((r) => r.agentId === where.agentId)
        .map(({ skillId, sortOrder }) => ({ skillId, sortOrder }))
    ),
  };
  const nullFinder = {
    create: vi.fn(async () => ({ id: 'row-id' })),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async () => ({ id: 'row-id' })),
  };
  const client = {
    agent,
    agentSkillRef,
    evalRubric: nullFinder,
    scannerPattern: { upsert: vi.fn(async () => ({})) },
    skill: nullFinder,
    workflowTemplate: nullFinder,
    workflowTemplateVersion: { upsert: vi.fn(async () => ({})) },
  };
  const prisma = {
    ...client,
    $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => fn(client)),
  };
  return { agents, prisma: prisma as unknown as PrismaClient, refs };
}

const lineage = (agents: AgentRecord[], key: string) =>
  agents.filter((a) => a.key === key && a.scope === 'GLOBAL').sort((a, b) => a.version - b.version);

describe('syncAgents — seeded model default upgrade', () => {
  it('cuts a new version for an untouched seeded row and leaves the pinned version intact', async () => {
    const v1 = seededRow({ key: 'implementer', modelSpec: 'anthropic/claude-opus-4-8' });
    const { agents, prisma, refs } = makeStore(
      [v1],
      [{ agentId: v1.id, skillId: 'skill-tdd', sortOrder: 0 }]
    );

    await seedSweStarter(prisma);

    const rows = lineage(agents, 'implementer');
    expect(rows.map((r) => [r.version, r.modelSpec, r.isActive])).toEqual([
      [1, 'anthropic/claude-opus-4-8', true],
      [2, 'anthropic/claude-opus-5-5', true],
    ]);
    const v2 = rows[1] as AgentRecord;
    // Everything but the model carries over from the version it replaces.
    expect(v2).toMatchObject({
      credentialId: 'cred-1',
      description: 'seeded',
      isBuiltIn: true,
      isVerified: true,
      origin: 'swe-starter',
      systemPrompt: 'existing prompt',
      toolKeys: ['readFile', 'bash'],
    });
    expect(refs.filter((r) => r.agentId === v2.id)).toEqual([
      { agentId: v2.id, skillId: 'skill-tdd', sortOrder: 0 },
    ]);
  });

  it('bumps the Sonnet-tier default the same way', async () => {
    const { agents, prisma } = makeStore([
      seededRow({ key: 'planner', modelSpec: 'anthropic/claude-sonnet-4-6' }),
    ]);

    await seedSweStarter(prisma);

    expect(lineage(agents, 'planner').map((r) => r.modelSpec)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-sonnet-5-5',
    ]);
  });

  it('leaves an admin-customized model alone', async () => {
    const { agents, prisma } = makeStore([
      seededRow({ key: 'implementer', modelSpec: 'openai/gpt-6-astra', version: 3 }),
      // A previous default, but not the one this key defaults to — an admin's choice.
      seededRow({ key: 'planner', modelSpec: 'anthropic/claude-opus-4-8' }),
      // Kept default — not part of the upgrade.
      seededRow({ key: 'evalJudge', modelSpec: 'anthropic/claude-haiku-4-5-20251001' }),
    ]);

    await seedSweStarter(prisma);

    expect(lineage(agents, 'implementer').map((r) => r.modelSpec)).toEqual(['openai/gpt-6-astra']);
    expect(lineage(agents, 'planner').map((r) => r.modelSpec)).toEqual([
      'anthropic/claude-opus-4-8',
    ]);
    expect(lineage(agents, 'evalJudge')).toHaveLength(1);
  });

  it('judges the latest version only, so a customized lineage is not reverted', async () => {
    const { agents, prisma } = makeStore([
      seededRow({ key: 'reviewer', modelSpec: 'anthropic/claude-opus-4-8', version: 1 }),
      seededRow({ key: 'reviewer', modelSpec: 'google/gemini-3.1-pro-preview', version: 2 }),
    ]);

    await seedSweStarter(prisma);

    expect(lineage(agents, 'reviewer')).toHaveLength(2);
  });

  it('does not revive a soft-deleted lineage', async () => {
    const { agents, prisma } = makeStore([
      seededRow({ isActive: false, key: 'reviewer', modelSpec: 'anthropic/claude-opus-4-8' }),
    ]);

    await seedSweStarter(prisma);

    expect(lineage(agents, 'reviewer')).toHaveLength(1);
  });

  it('is idempotent across repeated syncs', async () => {
    const { agents, prisma } = makeStore([
      seededRow({ key: 'implementer', modelSpec: 'anthropic/claude-opus-4-8' }),
      seededRow({ key: 'planner', modelSpec: 'anthropic/claude-sonnet-4-6' }),
    ]);

    await seedSweStarter(prisma);
    const afterFirst = agents.length;
    await seedSweStarter(prisma);

    expect(agents.length).toBe(afterFirst);
    expect(lineage(agents, 'implementer')).toHaveLength(2);
    expect(lineage(agents, 'planner')).toHaveLength(2);
  });

  it('seeds a fresh deployment straight onto the current defaults', async () => {
    const { agents, prisma } = makeStore([]);

    await seedSweStarter(prisma);

    expect(lineage(agents, 'implementer').map((r) => r.modelSpec)).toEqual([
      'anthropic/claude-opus-5-5',
    ]);
    expect(lineage(agents, 'planner').map((r) => r.modelSpec)).toEqual([
      'anthropic/claude-sonnet-5-5',
    ]);
  });
});
