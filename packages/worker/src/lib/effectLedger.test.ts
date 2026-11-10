import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  info: vi.fn(),
  runId: vi.fn(),
}));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { runEffect: { create: h.create } } }));
vi.mock('@temporalio/activity', () => ({ activityInfo: h.info }));
vi.mock('./activityContext.js', () => ({ currentWorkflowRunId: h.runId }));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));
vi.mock('./activityNodeTag.js', () => ({ currentNodeTag: () => ({ specNodeId: 'impl' }) }));
vi.mock('./spendOwner.js', () => ({
  currentSpendOwner: async () => ({ orgId: 'org-1', teamId: 'team-1' }),
}));

import { logWarn } from './activityLog.js';
import {
  mcpToolIsReadOnly,
  recordEffect,
  recordGitPush,
  recordTrackerSync,
} from './effectLedger.js';

const data = () => h.create.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  h.info.mockReturnValue({ workflowExecution: { workflowId: 'wf-1' } });
  h.runId.mockResolvedValue('run-1');
  h.create.mockResolvedValue({});
});

describe('recordEffect', () => {
  it('stamps the run, workflow, node and tenant context', async () => {
    await recordEffect({
      action: 'create',
      kind: 'PULL_REQUEST',
      status: 'DONE',
      target: 'https://github.com/a/b/pull/1',
      via: 'activity',
    });
    expect(data()).toMatchObject({
      action: 'create',
      kind: 'PULL_REQUEST',
      orgId: 'org-1',
      runId: 'run-1',
      specNodeId: 'impl',
      status: 'DONE',
      teamId: 'team-1',
      via: 'activity',
      workflowId: 'wf-1',
    });
  });

  it('stores a digest of the redacted input, never the input', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await recordEffect({
      action: 't',
      input: { a: 1, token: secret },
      kind: 'MCP_TOOL',
      status: 'DONE',
      via: 'harness_relay',
    });
    const row = data();
    expect(row.inputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(secret);
    h.create.mockClear();
    // Key order and the secret's value do not change the digest: it is of the redacted form.
    await recordEffect({
      action: 't',
      input: { a: 1, token: 'other-secret' },
      kind: 'MCP_TOOL',
      status: 'DONE',
      via: 'harness_relay',
    });
    expect(data().inputDigest).toBe(row.inputDigest);
  });

  it('redacts detail, error and target and caps their size', async () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await recordEffect({
      action: 'push',
      detail: { note: `Authorization: Bearer ${secret}`, password: 'hunter2' },
      error: new Error(`failed with token=${secret} ${'x'.repeat(5_000)}`),
      kind: 'GIT_PUSH',
      status: 'FAILED',
      target: `https://user:pw@example.com/${'p'.repeat(2_000)}`,
      via: 'activity',
    });
    const row = data();
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain('hunter2');
    expect(JSON.stringify(row)).not.toContain('user:pw');
    expect(row.error.length).toBeLessThan(1_100);
    expect(row.target.length).toBeLessThan(600);
  });

  it('replaces an oversized detail with a truncated preview', async () => {
    await recordEffect({
      action: 'x',
      detail: { big: 'y'.repeat(10_000) },
      kind: 'MCP_TOOL',
      status: 'DONE',
      via: 'mastra_mcp',
    });
    const detail = data().detail as { truncated: boolean; preview: string };
    expect(detail.truncated).toBe(true);
    expect(detail.preview.length).toBeLessThanOrEqual(4_000);
  });

  it('never throws when the write fails, and says so', async () => {
    h.create.mockRejectedValue(new Error('db down'));
    await expect(
      recordEffect({ action: 'x', kind: 'MCP_TOOL', status: 'DONE', via: 'activity' })
    ).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      'run effect could not be recorded',
      expect.objectContaining({ error: 'db down' })
    );
  });

  it('does not throw even when the logger does', async () => {
    h.create.mockRejectedValue(new Error('db down'));
    vi.mocked(logWarn).mockImplementationOnce(() => {
      throw new Error('logger down');
    });
    await expect(
      recordEffect({ action: 'x', kind: 'MCP_TOOL', status: 'DONE', via: 'activity' })
    ).resolves.toBeUndefined();
  });

  it('writes nothing, and does not throw, outside an activity', async () => {
    h.info.mockImplementation(() => {
      throw new Error('Activity context not initialized');
    });
    await expect(
      recordEffect({ action: 'x', kind: 'MCP_TOOL', status: 'DONE', via: 'activity' })
    ).resolves.toBeUndefined();
    expect(h.create).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalled();
  });

  it('keeps the row when the run row cannot be found', async () => {
    h.runId.mockResolvedValue(undefined);
    await recordEffect({ action: 'x', kind: 'MCP_TOOL', status: 'DONE', via: 'activity' });
    expect(data()).toMatchObject({ runId: null, workflowId: 'wf-1' });
  });
});

describe('mcpToolIsReadOnly', () => {
  it('reads the hint from a Mastra tool and from an MCP SDK tool; unknown is a mutation', () => {
    expect(mcpToolIsReadOnly({ mcp: { annotations: { readOnlyHint: true } } })).toBe(true);
    expect(mcpToolIsReadOnly({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(mcpToolIsReadOnly({ annotations: { readOnlyHint: false } })).toBe(false);
    expect(mcpToolIsReadOnly({})).toBe(false);
    expect(mcpToolIsReadOnly(undefined)).toBe(false);
  });
});

describe('recordGitPush', () => {
  it('records a push and returns its result', async () => {
    await expect(recordGitPush('auto/T-1', 'abc', async () => 'out')).resolves.toBe('out');
    expect(data()).toMatchObject({
      action: 'push',
      detail: { headSha: 'abc' },
      kind: 'GIT_PUSH',
      status: 'DONE',
      target: 'auto/T-1',
    });
  });

  it('records a failed push and rethrows the same error', async () => {
    const err = new Error('rejected');
    await expect(
      recordGitPush('auto/T-1', undefined, async () => {
        throw err;
      })
    ).rejects.toBe(err);
    expect(data()).toMatchObject({ error: 'rejected', status: 'FAILED' });
  });

  it('still returns the push result when the ledger is down', async () => {
    h.create.mockRejectedValue(new Error('db down'));
    await expect(recordGitPush('b', 'abc', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('recordTrackerSync', () => {
  const event = { issueId: 'JIRA-1', type: 'pr_opened' };
  it('records a sync the tracker took and one it refused, but not an absent result', async () => {
    await recordTrackerSync(event, undefined);
    expect(h.create).not.toHaveBeenCalled();
    await recordTrackerSync(event, null);
    expect(data()).toMatchObject({ kind: 'TRACKER', status: 'DONE', target: 'JIRA-1' });
    h.create.mockClear();
    await recordTrackerSync(event, 'unauthorized');
    expect(data()).toMatchObject({ error: 'unauthorized', status: 'FAILED' });
  });
});
