import type { EpicPlanRequest, EpicRepoEntry } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { decomposeMock, prismaMock } = vi.hoisted(() => ({
  decomposeMock: vi.fn(),
  prismaMock: {
    connection: { findMany: vi.fn() },
    repoDependency: { findMany: vi.fn() },
  },
}));

vi.mock('@auto-swe/shared/db', () => ({ prisma: prismaMock }));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: vi.fn(async (_why: string, _models: string[], fn: () => unknown) => fn()),
}));
vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

vi.mock('../agents/plannerAgent.js', () => ({ decomposeEpic: decomposeMock }));
vi.mock('../lib/activityContext.js', () => ({ persistActivityTrace: vi.fn(async () => {}) }));
vi.mock('../lib/config/agentSkills.js', () => ({ loadAgentSkills: vi.fn(async () => []) }));
vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn(async () => ({ orgId: 'org-1', teamId: 'team-1' })),
}));

import { mergeStoredDependencies, planEpic } from './planEpic.js';

function entries(...pairs: [string, string[]][]): EpicRepoEntry[] {
  return pairs.map(([repoId, dependsOn]) => ({ dependsOn, repoId }));
}

describe('mergeStoredDependencies', () => {
  it('returns the planner output unchanged when the graph is empty', () => {
    const planned = entries(['a', []], ['b', ['a']]);
    expect(mergeStoredDependencies(planned, new Map())).toEqual(planned);
  });

  it('adds a stored edge the planner missed', () => {
    const merged = mergeStoredDependencies(entries(['a', []], ['b', []]), new Map([['b', ['a']]]));
    expect(merged).toEqual(entries(['a', []], ['b', ['a']]));
  });

  it('does not duplicate an edge the planner already found', () => {
    const merged = mergeStoredDependencies(
      entries(['a', []], ['b', ['a']]),
      new Map([['b', ['a']]])
    );
    expect(merged.find((e) => e.repoId === 'b')?.dependsOn).toEqual(['a']);
  });

  it('drops a stored neighbour that is not part of the epic', () => {
    const merged = mergeStoredDependencies(entries(['a', []]), new Map([['a', ['outside']]]));
    expect(merged).toEqual(entries(['a', []]));
  });

  it('never introduces a self-dependency', () => {
    const merged = mergeStoredDependencies(entries(['a', []]), new Map([['a', ['a']]]));
    expect(merged).toEqual(entries(['a', []]));
  });

  it('drops a stored edge that would close a two-node cycle', () => {
    // Planner says b depends on a; the graph says a depends on b. Taking both
    // would leave neither schedulable in epicOrchestrator's ready-loop.
    const merged = mergeStoredDependencies(
      entries(['a', []], ['b', ['a']]),
      new Map([['a', ['b']]])
    );
    expect(merged).toEqual(entries(['a', []], ['b', ['a']]));
  });

  it('drops a stored edge that would close a longer cycle', () => {
    const merged = mergeStoredDependencies(
      entries(['a', []], ['b', ['a']], ['c', ['b']]),
      new Map([['a', ['c']]])
    );
    expect(merged.find((e) => e.repoId === 'a')?.dependsOn).toEqual([]);
  });

  it('admits edges that keep the graph acyclic, including a diamond', () => {
    const merged = mergeStoredDependencies(
      entries(['a', []], ['b', ['a']], ['c', []], ['d', ['b']]),
      new Map([
        ['c', ['a']],
        ['d', ['c']],
      ])
    );
    expect(merged.find((e) => e.repoId === 'c')?.dependsOn).toEqual(['a']);
    expect(merged.find((e) => e.repoId === 'd')?.dependsOn).toEqual(['b', 'c']);
  });

  it('accounts for edges admitted earlier in the same merge', () => {
    // b←a is admitted first; a←b must then be rejected as a cycle.
    const merged = mergeStoredDependencies(
      entries(['b', []], ['a', []]),
      new Map([
        ['b', ['a']],
        ['a', ['b']],
      ])
    );
    expect(merged.find((e) => e.repoId === 'b')?.dependsOn).toEqual(['a']);
    expect(merged.find((e) => e.repoId === 'a')?.dependsOn).toEqual([]);
  });

  it('terminates on a cycle already present in the planner output', () => {
    const merged = mergeStoredDependencies(
      entries(['a', ['b']], ['b', ['a']], ['c', []]),
      new Map([['c', ['a']]])
    );
    expect(merged.find((e) => e.repoId === 'c')?.dependsOn).toEqual(['a']);
  });

  it('is deterministic — added edges are sorted and planner order is preserved', () => {
    const merged = mergeStoredDependencies(
      entries(['x', ['w']], ['a', []], ['b', []], ['c', []], ['w', []]),
      new Map([['x', ['c', 'a', 'b']]])
    );
    expect(merged.map((e) => e.repoId)).toEqual(['x', 'a', 'b', 'c', 'w']);
    expect(merged[0].dependsOn).toEqual(['w', 'a', 'b', 'c']);
  });
});

describe('planEpic', () => {
  const REQUEST: EpicPlanRequest = {
    description: 'ship it',
    repoIds: ['r1', 'r2'],
    requestPayload: '{}',
    workRequestId: 'wr-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.connection.findMany.mockResolvedValue([
      { description: '', id: 'r1', language: 'ts', repoName: 'api', team: { orgId: 'org-1' } },
      { description: '', id: 'r2', language: 'ts', repoName: 'web', team: { orgId: 'org-1' } },
    ]);
    prismaMock.repoDependency.findMany.mockResolvedValue([]);
    decomposeMock.mockResolvedValue([
      { dependsOn: [], repoId: 'r1' },
      { dependsOn: [], repoId: 'r2' },
    ]);
  });

  it('unions the stored graph into the planner DAG', async () => {
    // r2 → r1 is an active edge: r2 depends on r1.
    prismaMock.repoDependency.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.fromRepoId === 'r2'
          ? [{ confidence: 1, id: 'e1', kind: 'code', source: 'manifest', toRepoId: 'r1' }]
          : []
    );
    prismaMock.connection.findMany.mockImplementation(async ({ select }: { select: object }) =>
      'team' in select
        ? [
            {
              description: '',
              id: 'r1',
              language: 'ts',
              repoName: 'api',
              team: { orgId: 'org-1' },
            },
            {
              description: '',
              id: 'r2',
              language: 'ts',
              repoName: 'web',
              team: { orgId: 'org-1' },
            },
          ]
        : [{ id: 'r1', name: null, organizationName: 'acme', repoName: 'api', teamId: 't1' }]
    );

    const result = await planEpic(REQUEST);

    expect(result).toEqual([
      { dependsOn: [], repoId: 'r1' },
      { dependsOn: ['r1'], repoId: 'r2' },
    ]);
  });

  it('reads each repo orgId off its own team row', async () => {
    await planEpic(REQUEST);
    const select = prismaMock.connection.findMany.mock.calls[0][0].select;
    expect(select.team).toEqual({ select: { orgId: true } });
  });

  it('falls back to the planner output when the graph read fails', async () => {
    prismaMock.repoDependency.findMany.mockRejectedValue(new Error('db down'));
    const result = await planEpic(REQUEST);
    expect(result).toEqual([
      { dependsOn: [], repoId: 'r1' },
      { dependsOn: [], repoId: 'r2' },
    ]);
  });
});
