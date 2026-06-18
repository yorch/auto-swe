import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertMock } = vi.hoisted(() => ({ upsertMock: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { contextSnapshot: { upsert: upsertMock } },
}));

vi.mock('@temporalio/activity', () => ({ heartbeat: vi.fn() }));

vi.mock('../lib/config/contextLookup.js', () => ({
  currentRequestContext: vi.fn().mockResolvedValue({ teamId: 'team-1' }),
}));

const { fakeSpec } = vi.hoisted(() => ({ fakeSpec: { agentKey: 'validateContext' } }));
vi.mock('../lib/config/agentSpec.js', () => ({
  resolveAgentSpec: vi.fn().mockResolvedValue(fakeSpec),
}));

vi.mock('./runAgent.js', () => ({ runAgent: vi.fn() }));

import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { runAgent } from './runAgent.js';
import { validateContext } from './validateContext.js';

const mockedRunAgent = vi.mocked(runAgent);
const mockedResolveSpec = vi.mocked(resolveAgentSpec);

const workRequest: RepoWorkRequest = {
  description: 'Add a health endpoint',
  externalTicketId: 'JIRA-1',
  repoIds: ['repo-1'],
  requestPayload: { priority: 'high' },
  workRequestId: 'wr-1',
} as unknown as RepoWorkRequest;

beforeEach(() => {
  vi.clearAllMocks();
  upsertMock.mockResolvedValue({ id: 'snap-1' });
});

describe('validateContext (WS3 proof-migration)', () => {
  it('resolves a tool-free spec for the validateContext role and runs it', async () => {
    mockedRunAgent.mockResolvedValue({ object: { successCriteria: ['c1', 'c2'] } });

    const result = await validateContext(workRequest);

    expect(result).toEqual({ contextSnapshotId: 'snap-1', successCriteria: ['c1', 'c2'] });

    // Spec resolved for the right role.
    expect(mockedResolveSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKey: 'validateContext',
        outputSchema: expect.anything(),
        promptOverride: undefined,
      }),
      { teamId: 'team-1' }
    );

    // runAgent driven by the resolved spec, with the context-validation span.
    expect(mockedRunAgent).toHaveBeenCalledWith(fakeSpec, expect.any(String), {
      spanName: 'llm.context_validation',
    });

    // The user message carries the work-request fields.
    const userMessage = mockedRunAgent.mock.calls[0][1] as string;
    expect(JSON.parse(userMessage)).toEqual({
      description: 'Add a health endpoint',
      requestPayload: { priority: 'high' },
      title: 'JIRA-1',
    });
  });

  it('persists the criteria to the context snapshot (idempotent upsert)', async () => {
    mockedRunAgent.mockResolvedValue({ object: { successCriteria: ['only'] } });

    await validateContext(workRequest);

    expect(upsertMock).toHaveBeenCalledWith({
      create: { successCriteria: ['only'], workRequestId: 'wr-1' },
      update: { successCriteria: ['only'] },
      where: { workRequestId: 'wr-1' },
    });
  });

  it('degrades gracefully to empty criteria when the agent throws', async () => {
    mockedRunAgent.mockRejectedValue(new Error('LLM unavailable'));

    const result = await validateContext(workRequest);

    expect(result).toEqual({ contextSnapshotId: 'snap-1', successCriteria: [] });
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ create: { successCriteria: [], workRequestId: 'wr-1' } })
    );
  });

  it('treats a missing structured object as empty criteria', async () => {
    mockedRunAgent.mockResolvedValue({});
    const result = await validateContext(workRequest);
    expect(result.successCriteria).toEqual([]);
  });

  it('forwards a systemPrompt override into the spec resolution', async () => {
    mockedRunAgent.mockResolvedValue({ object: { successCriteria: [] } });

    await validateContext(workRequest, 'CUSTOM_PROMPT');

    expect(mockedResolveSpec).toHaveBeenCalledWith(
      expect.objectContaining({ promptOverride: 'CUSTOM_PROMPT' }),
      expect.anything()
    );
  });
});
