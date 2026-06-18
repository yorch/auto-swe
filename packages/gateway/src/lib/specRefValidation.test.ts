import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSpecRefs } from './specRefValidation.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function mockPrisma(opts: { agentKeys?: string[]; mcpIds?: string[] } = {}) {
  return {
    agent: { findMany: vi.fn().mockResolvedValue((opts.agentKeys ?? []).map((key) => ({ key }))) },
    connection: {
      findMany: vi.fn().mockResolvedValue((opts.mcpIds ?? []).map((id) => ({ id }))),
    },
  } as unknown as Parameters<typeof validateSpecRefs>[0];
}

const spec = (nodes: Record<string, unknown>) => ({ nodes }) as unknown as WorkflowSpec;

beforeEach(() => vi.clearAllMocks());

describe('validateSpecRefs', () => {
  it('returns no warnings for a spec with no agent/mcp nodes', async () => {
    const w = await validateSpecRefs(mockPrisma(), spec({ a: { step: 'runLint', type: 'step' } }));
    expect(w).toEqual([]);
  });

  it('warns on an agent node whose key has no active Agent', async () => {
    const w = await validateSpecRefs(
      mockPrisma({ agentKeys: [] }),
      spec({ a: { agentRef: 'customReviewer', type: 'agent' } })
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/agent 'customReviewer' has no active Agent/);
  });

  it('does not warn when the agent key resolves (and strips @version)', async () => {
    const w = await validateSpecRefs(
      mockPrisma({ agentKeys: ['reviewer'] }),
      spec({ a: { agentRef: 'reviewer@3', type: 'agent' } })
    );
    expect(w).toEqual([]);
  });

  it('warns on an mcp node whose connection is missing or not active mcp', async () => {
    const w = await validateSpecRefs(
      mockPrisma({ mcpIds: [] }),
      spec({ a: { connectionRef: UUID_A, tool: 'search', type: 'mcp' } })
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/is not an active mcp connection/);
  });

  it('does not warn when the mcp connection resolves', async () => {
    const w = await validateSpecRefs(
      mockPrisma({ mcpIds: [UUID_A] }),
      spec({ a: { connectionRef: UUID_A, tool: 'search', type: 'mcp' } })
    );
    expect(w).toEqual([]);
  });

  it('warns on a non-UUID mcp connectionRef without hitting the DB with it', async () => {
    const prisma = mockPrisma();
    const w = await validateSpecRefs(
      prisma,
      spec({ a: { connectionRef: 'not-a-uuid', tool: 'search', type: 'mcp' } })
    );
    expect(w).toHaveLength(1);
    // No well-formed ids → connection.findMany is skipped entirely.
    expect(prisma.connection.findMany).not.toHaveBeenCalled();
  });

  it('collects warnings across multiple nodes', async () => {
    const w = await validateSpecRefs(
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
});
