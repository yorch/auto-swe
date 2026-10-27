import { beforeEach, describe, expect, it, vi } from 'vitest';

const cancel = vi.hoisted(() => ({ ctl: new AbortController() }));
/** Mutable so a test can pretend the call runs inside a workflow with a row. */
const ctx = vi.hoisted(() => ({ info: { attempt: 1 } as Record<string, unknown> }));
vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string) => {
      const err = new Error(message) as Error & { type?: string };
      err.type = type;
      return err;
    },
  },
  Context: { current: () => ({ cancellationSignal: cancel.ctl.signal, info: ctx.info }) },
  heartbeat: vi.fn(),
}));
// The run and its connection: the activity refuses a connection the run's template
// team cannot reach before it loads any tool.
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    autonomyDecision: { findFirst: vi.fn() },
    connection: { findUnique: vi.fn() },
    workflowOutcomeReference: {
      // The effect is claimed before the provider is called and completed afterwards, so a mock
      // needs all four: the claim (`create`), the completion (`updateMany`), the read, and the
      // release a connector uses when it refused before sending (`deleteMany`).
      create: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    workflowRun: { findUnique: vi.fn() },
  },
}));
vi.mock('../lib/config/mcpConnection.js', () => ({ mcpUrlForConnection: vi.fn() }));
vi.mock('../agents/mcpTools.js', () => ({
  loadMcpTools: vi.fn(),
  sanitizeToolName: (n: string) => n.replace(/[^A-Za-z0-9_-]/g, '_'),
}));
vi.mock('../lib/activityContext.js', () => ({
  persistActivityTrace: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/agentTracer.js', () => ({
  AgentTracer: class {
    addToolCall() {}
    addActivityEvent() {}
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { loadMcpTools } from '../agents/mcpTools.js';
import { mcpUrlForConnection } from '../lib/config/mcpConnection.js';
import { mcpCallTool } from './mcpCallTool.js';

const mockedUrl = vi.mocked(mcpUrlForConnection);
const mockedLoad = vi.mocked(loadMcpTools);

beforeEach(() => {
  vi.clearAllMocks();
  cancel.ctl = new AbortController();
  // Inside a workflow, as every real call is: the reachability check fails closed without a
  // run, so a case wanting the no-run path sets `ctx.info = { attempt: 1 }` itself.
  ctx.info = { attempt: 1, workflowExecution: { workflowId: 'wf-1' } };
  // And the run is authorized: the connection belongs to its template team, so the access
  // check passes and each case below exercises what it names. The fixture carries the other
  // fields a consumer reads (`id`, for the outcome ledger) so one run serves them all.
  (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 'run-1',
    template: { teamId: 'team-a' },
  });
  (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    isActive: true,
    shares: [],
    teamId: 'team-a',
  });
});

describe('mcpCallTool', () => {
  it('invokes the named tool with the inputs, returns its result, and closes the client', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: { mcp_search_docs: { execute } } } as never);

    const result = await mcpCallTool({
      connectionRef: 'c1',
      inputs: { q: 'x' },
      tool: 'search_docs',
    });

    expect(result).toEqual({ result: { ok: 1 } });
    expect(execute).toHaveBeenCalledWith({ q: 'x' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('threads the connection timeout overrides into loadMcpTools', async () => {
    mockedUrl.mockResolvedValue({
      callTimeoutMs: 5000,
      listTimeoutMs: 2500,
      url: 'https://mcp.example.com/mcp',
    });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: { mcp_search_docs: { execute } } } as never);

    await mcpCallTool({ connectionRef: 'c1', inputs: { q: 'x' }, tool: 'search_docs' });

    expect(mockedLoad).toHaveBeenCalledWith(
      { callTimeoutMs: 5000, listTimeoutMs: 2500, url: 'https://mcp.example.com/mcp' },
      expect.anything()
    );
  });

  it('hands loadMcpTools the whole target, so the connection allowlist travels with it', async () => {
    const target = { allowedTools: ['rules-search'], url: 'https://mcp.example.com/mcp' };
    mockedUrl.mockResolvedValue(target);
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: { 'mcp_rules-search': { execute } } } as never);

    await mcpCallTool({ connectionRef: 'c1', tool: 'rules-search' });

    expect(mockedLoad.mock.calls[0]?.[0]).toBe(target);
  });

  it('refuses a tool outside the connection allowlist before connecting', async () => {
    mockedUrl.mockResolvedValue({
      allowedTools: ['rules-search'],
      url: 'https://mcp.example.com/mcp',
    });

    await expect(mcpCallTool({ connectionRef: 'c1', tool: 'rules-update' })).rejects.toThrow(
      /not permitted by the connection's tool allowlist/
    );
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('refuses every tool when the allowlist is empty', async () => {
    mockedUrl.mockResolvedValue({ allowedTools: [], url: 'https://mcp.example.com/mcp' });
    await expect(mcpCallTool({ connectionRef: 'c1', tool: 'rules-search' })).rejects.toThrow(
      /allowlist/
    );
  });

  it('throws when the connection is not an active mcp connection', async () => {
    mockedUrl.mockResolvedValue(null);
    await expect(mcpCallTool({ connectionRef: 'c1', tool: 't' })).rejects.toThrow(
      /not an active mcp connection/
    );
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it('refuses a connection the run may not use, before loading any tool', async () => {
    // The `connectionRef` is a literal in the spec, so nothing upstream authorized it:
    // this is the check that stops a template spending another team's MCP token.
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      isActive: true,
      shares: [],
      teamId: 'team-b',
    });
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });

    await expect(mcpCallTool({ connectionRef: 'c1', tool: 't' })).rejects.toThrow(
      /may not use connection/
    );
    expect(mockedLoad).not.toHaveBeenCalled();
    expect(mockedUrl).not.toHaveBeenCalled();
  });

  it('throws when the tool is missing from the server but still closes the client', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: {} } as never);

    await expect(mcpCallTool({ connectionRef: 'c1', tool: 'missing' })).rejects.toThrow(
      /not found/
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('mcpCallTool (cancellation)', () => {
  it('does not call the tool when the activity was cancelled while connecting', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockImplementation((async () => {
      cancel.ctl.abort(new Error('activity cancelled'));
      return { close, tools: { mcp_search_docs: { execute } } };
    }) as never);

    await expect(mcpCallTool({ connectionRef: 'c1', tool: 'search_docs' })).rejects.toThrow(
      'activity cancelled'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops waiting on an in-flight tool call when cancelled, and still closes the client', async () => {
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn(() => new Promise(() => undefined));
    const close = vi.fn().mockResolvedValue(undefined);
    mockedLoad.mockResolvedValue({ close, tools: { mcp_search_docs: { execute } } } as never);

    const pending = mcpCallTool({ connectionRef: 'c1', tool: 'search_docs' });
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    cancel.ctl.abort(new Error('activity cancelled'));

    await expect(pending).rejects.toThrow('activity cancelled');
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('mcpCallTool governance', () => {
  // A call this node cannot prove is a read is governed as a mutation: refused
  // when the run recorded a policy decision requiring an approval that never
  // came, and written to the outcome ledger so a retry returns the first result.
  // Before this, an `mcp` node reached an external system with neither guard.
  beforeEach(() => {
    ctx.info = { attempt: 1, workflowExecution: { workflowId: 'wf-1' } };
    // `template` too: the reachability check reads the run's template team and refuses one
    // it cannot attribute, so a fixture without it would be refused before the governance
    // behaviour under test.
    vi.mocked(prisma.workflowRun.findUnique).mockResolvedValue({
      id: 'run-1',
      template: { teamId: 'team-a' },
    } as never);
  });

  function loadedTool(tool: unknown) {
    return {
      close: vi.fn().mockResolvedValue(undefined),
      tools: { mcp_search_docs: tool },
    } as never;
  }

  it('refuses a call that is not declared read-only when an approval is missing', async () => {
    vi.mocked(prisma.autonomyDecision.findFirst)
      .mockResolvedValueOnce({
        createdAt: new Date('2026-01-01T00:00:00Z'),
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'external_write',
      } as never)
      .mockResolvedValueOnce(null);
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    mockedLoad.mockResolvedValue(loadedTool({ execute }));

    await expect(
      mcpCallTool({ connectionRef: 'c1', nodeId: 'do', tool: 'search_docs' })
    ).rejects.toThrow(/requires human approval/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('gates a mutating call that has a run but no nodeId, without touching the ledger', async () => {
    vi.mocked(prisma.autonomyDecision.findFirst)
      .mockResolvedValueOnce({
        createdAt: new Date('2026-01-01T00:00:00Z'),
        payload: { decision: 'require_approval' },
        policyName: 'default',
        riskClass: 'external_write',
      } as never)
      .mockResolvedValueOnce(null);
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    mockedLoad.mockResolvedValue(loadedTool({ execute }));

    await expect(mcpCallTool({ connectionRef: 'c1', tool: 'search_docs' })).rejects.toHaveProperty(
      'type',
      'APPROVAL_REQUIRED'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.findFirst).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('lets a server-declared read-only tool through under the same policy', async () => {
    // The MCP `readOnlyHint` annotation is the protocol's own signal that a call
    // has no effect. Refusing a read because an unrelated write is waiting for a
    // person would be a false refusal, so an annotated tool is exempt — exactly
    // as a connector read is.
    vi.mocked(prisma.autonomyDecision.findFirst).mockResolvedValueOnce({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      payload: { decision: 'require_approval' },
    } as never);
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ hits: 3 });
    mockedLoad.mockResolvedValue(
      loadedTool({ execute, mcp: { annotations: { readOnlyHint: true } } })
    );

    const result = await mcpCallTool({
      connectionRef: 'c1',
      nodeId: 'do',
      tool: 'search_docs',
    });

    expect(result).toEqual({ result: { hits: 3 } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(prisma.autonomyDecision.findFirst).not.toHaveBeenCalled();
    expect(prisma.workflowOutcomeReference.create).not.toHaveBeenCalled();
  });

  it('records its own result shape, so a retry returns exactly what the first call returned', async () => {
    // Reset rather than re-mock: the read-only test above deliberately queues a
    // `require_approval` decision it never consumes, and the shared beforeEach
    // only clears call history.
    vi.mocked(prisma.autonomyDecision.findFirst).mockReset();
    vi.mocked(prisma.autonomyDecision.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.workflowOutcomeReference.findFirst).mockReset();
    vi.mocked(prisma.workflowOutcomeReference.create).mockReset();
    vi.mocked(prisma.workflowOutcomeReference.updateMany).mockReset();
    mockedUrl.mockResolvedValue({ url: 'https://mcp.example.com/mcp' });
    const execute = vi.fn().mockResolvedValue({ ok: 1 });
    mockedLoad.mockResolvedValue(loadedTool({ execute }));

    // Round-trip through the ledger: the first call's own recorded value is what
    // the retry reads back. Returning the remote payload unwrapped instead would
    // change the activity's result shape on retry and break a downstream binding
    // to `nodes.<id>.output.result`.
    const recorded: unknown[] = [];
    vi.mocked(prisma.workflowOutcomeReference.updateMany).mockImplementation((async (arg: {
      data: { result: unknown };
    }) => {
      recorded.push(arg.data.result);
      return { count: 1 } as never;
    }) as never);
    vi.mocked(prisma.workflowOutcomeReference.findFirst).mockImplementation((async () => {
      const next = recorded.shift();
      return next === undefined ? null : ({ result: next, state: 'DONE' } as never);
    }) as never);

    const args = { connectionRef: 'c1', nodeId: 'do', tool: 'search_docs' };
    const first = await mcpCallTool(args);
    const second = await mcpCallTool(args);

    expect(first).toEqual({ result: { ok: 1 } });
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([]);
  });
});
