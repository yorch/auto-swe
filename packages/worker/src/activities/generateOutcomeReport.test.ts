import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { workflowArtifact: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
const putArtifact = vi.fn();
const deleteArtifact = vi.fn();
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  deleteArtifact: (...a: unknown[]) => deleteArtifact(...a),
  putArtifact: (...a: unknown[]) => putArtifact(...a),
}));
const buildOutcomeReport = vi.fn();
vi.mock('@auto-swe/shared/lib/outcomeReport', () => ({
  buildOutcomeReport: (...a: unknown[]) => buildOutcomeReport(...a),
  OUTCOME_REPORT_ARTIFACT_KIND: 'outcome-report',
}));
const warn = vi.fn();
const info = vi.fn();
vi.mock('@temporalio/activity', () => ({
  log: { info: (...a: unknown[]) => info(...a), warn: (...a: unknown[]) => warn(...a) },
}));

import { generateOutcomeReport, OUTCOME_REPORT_SNAPSHOTS_KEPT } from './generateOutcomeReport.js';

const report = {
  inputs: { truncated: false },
  overall: { prsMerged: 3, workItems: 9 },
  window: { end: '2026-03-10T00:00:00.000Z', start: '2025-12-10T00:00:00.000Z' },
};

beforeEach(() => {
  vi.clearAllMocks();
  buildOutcomeReport.mockResolvedValue(report);
  putArtifact.mockResolvedValue({ id: 'new-1' });
  findMany.mockResolvedValue([]);
});

describe('generateOutcomeReport', () => {
  it('stores the report as JSON and returns counts only', async () => {
    const result = await generateOutcomeReport();
    expect(putArtifact).toHaveBeenCalledWith({
      body: JSON.stringify(report),
      contentType: 'application/json',
      kind: 'outcome-report',
    });
    expect(result).toEqual({
      artifactId: 'new-1',
      prsMerged: 3,
      pruned: 0,
      truncated: false,
      windowEnd: report.window.end,
      windowStart: report.window.start,
      workItems: 9,
    });
  });

  it('deletes snapshots past the newest few', async () => {
    findMany.mockResolvedValue([{ id: 'old-1' }, { id: 'old-2' }]);
    const result = await generateOutcomeReport();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: OUTCOME_REPORT_SNAPSHOTS_KEPT })
    );
    expect(deleteArtifact.mock.calls).toEqual([['old-1'], ['old-2']]);
    expect(result.pruned).toBe(2);
  });

  it('keeps the new snapshot when retention fails', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    await expect(generateOutcomeReport()).resolves.toMatchObject({
      artifactId: 'new-1',
      pruned: 0,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
