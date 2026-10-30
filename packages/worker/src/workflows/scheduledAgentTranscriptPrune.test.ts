import { beforeEach, describe, expect, it, vi } from 'vitest';

const prune = vi.hoisted(() => ({
  pruneAgentTranscripts: vi.fn(),
  pruneUiEvidence: vi.fn(),
}));

vi.mock('@temporalio/workflow', () => ({
  log: { warn: vi.fn() },
  proxyActivities: () => prune,
}));

import { ScheduledAgentTranscriptPruneWorkflow } from './scheduledAgentTranscriptPrune.js';

describe('ScheduledAgentTranscriptPruneWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prune.pruneAgentTranscripts.mockResolvedValue({ deleted: 3 });
    prune.pruneUiEvidence.mockResolvedValue({ deleted: 2 });
  });

  it('runs evidence retention after transcript retention', async () => {
    await expect(ScheduledAgentTranscriptPruneWorkflow()).resolves.toEqual({ deleted: 3 });
    expect(prune.pruneAgentTranscripts.mock.invocationCallOrder[0]).toBeLessThan(
      prune.pruneUiEvidence.mock.invocationCallOrder[0]
    );
  });

  it('does not fail transcript pruning when evidence retention fails', async () => {
    prune.pruneUiEvidence.mockRejectedValue(new Error('storage unavailable'));
    await expect(ScheduledAgentTranscriptPruneWorkflow()).resolves.toEqual({ deleted: 3 });
  });
});
