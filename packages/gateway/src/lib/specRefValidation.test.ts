import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findSpecRefProblems, validateSpecRefs } from './specRefValidation.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/** The team the template being checked belongs to. */
const TEMPLATE_TEAM = 'team-a';

interface McpRow {
  id: string;
  teamId?: string;
  shares?: { teamId: string }[];
}

function mockPrisma(
  opts: {
    agentKeys?: string[];
    mcpConnections?: McpRow[];
    mcpIds?: string[];
    rubricSlugs?: string[];
  } = {}
) {
  // `mcpIds` is the older shorthand: a connection owned by the template's own team, so
  // the existing cases keep testing what they name.
  const connections: McpRow[] =
    opts.mcpConnections ?? (opts.mcpIds ?? []).map((id) => ({ id, teamId: TEMPLATE_TEAM }));
  return {
    agent: { findMany: vi.fn().mockResolvedValue((opts.agentKeys ?? []).map((key) => ({ key }))) },
    connection: {
      findMany: vi.fn().mockResolvedValue(connections.map((c) => ({ shares: [], ...c }))),
    },
    evalRubric: {
      findMany: vi.fn().mockResolvedValue((opts.rubricSlugs ?? []).map((slug) => ({ slug }))),
    },
  } as unknown as Parameters<typeof validateSpecRefs>[0];
}

const spec = (nodes: Record<string, unknown>) => ({ nodes }) as unknown as WorkflowSpec;

/** Check a spec as `TEMPLATE_TEAM`'s template; `null` is a global (admin-authored) one. */
const refs = (
  prisma: Parameters<typeof validateSpecRefs>[0],
  s: WorkflowSpec,
  team: string | null = TEMPLATE_TEAM
) => validateSpecRefs(prisma, s, team);

beforeEach(() => vi.clearAllMocks());

describe('validateSpecRefs', () => {
  it('returns no warnings for a spec with no agent/mcp nodes', async () => {
    const w = await refs(mockPrisma(), spec({ a: { step: 'runLint', type: 'step' } }));
    expect(w).toEqual([]);
  });

  it('warns on an agent node whose key has no active Agent', async () => {
    const w = await refs(
      mockPrisma({ agentKeys: [] }),
      spec({ a: { agentRef: 'customReviewer', type: 'agent' } })
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/agent 'customReviewer' has no active Agent/);
  });

  it('does not warn when the agent key resolves (and strips @version)', async () => {
    const w = await refs(
      mockPrisma({ agentKeys: ['reviewer'] }),
      spec({ a: { agentRef: 'reviewer@3', type: 'agent' } })
    );
    expect(w).toEqual([]);
  });

  it('warns on an mcp node whose connection is missing or not active mcp', async () => {
    const w = await refs(
      mockPrisma({ mcpIds: [] }),
      spec({ a: { connectionRef: UUID_A, tool: 'search', type: 'mcp' } })
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/is not an active mcp connection/);
  });

  it('does not warn when the mcp connection resolves', async () => {
    const w = await refs(
      mockPrisma({ mcpIds: [UUID_A] }),
      spec({ a: { connectionRef: UUID_A, tool: 'search', type: 'mcp' } })
    );
    expect(w).toEqual([]);
  });

  it('warns on a non-UUID mcp connectionRef without hitting the DB with it', async () => {
    const prisma = mockPrisma();
    const w = await refs(
      prisma,
      spec({ a: { connectionRef: 'not-a-uuid', tool: 'search', type: 'mcp' } })
    );
    expect(w).toHaveLength(1);
    // No well-formed ids → connection.findMany is skipped entirely.
    expect(prisma.connection.findMany).not.toHaveBeenCalled();
  });

  it('collects warnings across multiple nodes', async () => {
    const w = await refs(
      mockPrisma({ agentKeys: ['reviewer'], mcpIds: [UUID_A] }),
      spec({
        bad_agent: { agentRef: 'missing', type: 'agent' },
        bad_mcp: { connectionRef: UUID_B, tool: 't', type: 'mcp' },
        ok_agent: { agentRef: 'reviewer', type: 'agent' },
        ok_mcp: { connectionRef: UUID_A, tool: 't', type: 'mcp' },
      })
    );
    expect(w).toHaveLength(2);
    expect(w.some((m) => m.includes('bad_agent'))).toBe(true);
    expect(w.some((m) => m.includes('bad_mcp'))).toBe(true);
  });

  it('warns when the mcp connection belongs to another team', async () => {
    // A literal reference is not a licence to spend another team's MCP token: the node
    // is refused at run time (`assertRunMayUseConnection`), and the author is told here.
    const w = await refs(
      mockPrisma({ mcpConnections: [{ id: UUID_A, teamId: 'team-b' }] }),
      spec({ a: { connectionRef: UUID_A, tool: 'search', type: 'mcp' } })
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/does not belong to this template's team/);
  });

  it('does not warn when the connection is shared with the template team', async () => {
    const w = await refs(
      mockPrisma({
        mcpConnections: [{ id: UUID_A, shares: [{ teamId: TEMPLATE_TEAM }], teamId: 'team-b' }],
      }),
      spec({ a: { connectionRef: UUID_A, tool: 'search', type: 'mcp' } })
    );
    expect(w).toEqual([]);
  });

  it('does not warn for a global template, which only an admin may author', async () => {
    const w = await refs(
      mockPrisma({ mcpConnections: [{ id: UUID_A, teamId: 'team-b' }] }),
      spec({ a: { connectionRef: UUID_A, tool: 'search', type: 'mcp' } }),
      null
    );
    expect(w).toEqual([]);
  });
});

describe('findSpecRefProblems (eval rubric refs)', () => {
  const evalNode = (scorers: unknown[]) => ({
    scorers,
    target: { from: 'input.diff' },
    type: 'eval',
  });

  it('warns on a judge whose rubric slug does not exist, located on the scorer', async () => {
    const problems = await findSpecRefProblems(
      mockPrisma({ rubricSlugs: [] }),
      spec({ e: evalNode([{ kind: 'pii' }, { kind: 'judge', rubricRef: 'missing' }]) }),
      TEMPLATE_TEAM
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: 'RUBRIC_REF_UNRESOLVED',
      field: 'scorers[1].rubricRef',
      nodeId: 'e',
    });
    expect(problems[0]?.message).toMatch(/rubric 'missing' is not an eval rubric slug/);
  });

  it('does not warn when the rubric slug exists', async () => {
    const prisma = mockPrisma({ rubricSlugs: ['code-review-quality'] });
    const problems = await findSpecRefProblems(
      prisma,
      spec({ e: evalNode([{ kind: 'judge', rubricRef: 'code-review-quality' }]) }),
      TEMPLATE_TEAM
    );
    expect(problems).toEqual([]);
  });

  it('warns on a slug@version spelling, which the run-time lookup never matches', async () => {
    const problems = await findSpecRefProblems(
      mockPrisma({ rubricSlugs: ['code-review-quality'] }),
      spec({ e: evalNode([{ kind: 'judge', rubricRef: 'code-review-quality@3' }]) }),
      TEMPLATE_TEAM
    );
    expect(problems.map((p) => p.code)).toEqual(['RUBRIC_REF_UNRESOLVED']);
  });

  it('does not query rubrics for an eval node with no judge scorer', async () => {
    const prisma = mockPrisma();
    await findSpecRefProblems(prisma, spec({ e: evalNode([{ kind: 'pii' }]) }), TEMPLATE_TEAM);
    expect(
      (prisma as unknown as { evalRubric: { findMany: ReturnType<typeof vi.fn> } }).evalRubric
        .findMany
    ).not.toHaveBeenCalled();
  });
});
