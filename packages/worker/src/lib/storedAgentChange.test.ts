import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ feedback: vi.fn(), source: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({ prisma: { workflowRun: { findUnique: m.source } } }));
vi.mock('./reviewFeedback.js', () => ({ readReviewFeedback: m.feedback }));

import { loadStoredAgentChange, storedFixInput } from './storedAgentChange.js';

const baseSha = 'a'.repeat(40);
const reviewed = () => ({
  approved: false,
  origin: 'agent_run',
  sourceRunId: 'source',
  status: 'SUCCESS',
  storedChange: { baseSha, diff: 'stored diff' },
});
beforeEach(() => {
  vi.resetAllMocks();
  m.source.mockResolvedValue({
    connectionId: 'repo',
    contextSnapshot: { result: { baseSha, deliver: 'none', diff: 'stored diff' } },
    endedAt: new Date(),
    steps: [],
    template: { origin: 'system:agent-run', teamId: null },
    workRequest: {
      description: 'original',
      payload: { agentRef: 'docsMaintainer', deliver: 'none' },
    },
  });
  m.feedback.mockResolvedValue(reviewed());
});
afterEach(() => vi.useRealTimers());
describe('stored source evidence', () => {
  it('loads the recorded base and agent, then binds a fix to precisely that reviewed change', async () => {
    expect(await loadStoredAgentChange('source', 'repo')).toMatchObject({
      agentPayload: { agentRef: 'docsMaintainer', deliver: 'none' },
      baseSha,
      diff: 'stored diff',
    });
    expect(await storedFixInput('review', 'repo', 'docsMaintainer')).toEqual({
      baseSha,
      diff: 'stored diff',
    });
  });
  it('rejects missing/empty source evidence and different-agent or changed-patch follow-ups', async () => {
    m.source.mockResolvedValueOnce(null);
    await expect(loadStoredAgentChange('source', 'repo')).rejects.toThrow(
      'not a finished agent run'
    );
    await expect(storedFixInput('review', 'repo', 'differentAgent')).rejects.toThrow(
      'does not match'
    );
    m.feedback.mockResolvedValueOnce({
      ...reviewed(),
      storedChange: { baseSha, diff: 'different patch' },
    });
    await expect(storedFixInput('review', 'repo', 'docsMaintainer')).rejects.toThrow(
      'does not match'
    );
  });
  it.each([{ status: 'FAILED' }, { approved: true }, { origin: 'workflow' }])(
    'never fixes an ineligible review',
    async (override) => {
      m.feedback.mockResolvedValueOnce({ ...reviewed(), ...override });
      await expect(storedFixInput('review', 'repo', 'docsMaintainer')).rejects.toThrow(
        'did not succeed'
      );
    }
  );
  it('waits for publication to complete before starting an agent session', async () => {
    vi.useFakeTimers();
    m.feedback.mockResolvedValueOnce({ ...reviewed(), status: 'RUNNING' });
    const result = storedFixInput('review', 'repo', 'docsMaintainer');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ baseSha, diff: 'stored diff' });
    expect(m.feedback).toHaveBeenCalledTimes(2);
  });
});
