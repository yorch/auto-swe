import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
}));
const artifacts = vi.hoisted(() => ({
  deleteArtifact: vi.fn(),
  putArtifact: vi.fn(),
}));
const settings = vi.hoisted(() => vi.fn());

vi.mock('../db.js', () => ({ prisma: db }));
vi.mock('./artifactStore.js', () => artifacts);
vi.mock('../config/resolveSetting.js', () => ({ resolveSetting: settings }));

import { recordRunEvidence } from './runEvidence.js';

describe('recordRunEvidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.mockImplementation((key: string) => {
      const values: Record<string, number> = {
        'uiValidation.maxEvidencePerRun': 2,
        'uiValidation.maxScreenshotBytes': 5,
        'uiValidation.maxVideoBytes': 50,
      };
      return Promise.resolve(values[key]);
    });
    artifacts.putArtifact.mockResolvedValue({ id: 'artifact-1' });
    artifacts.deleteArtifact.mockResolvedValue(undefined);
    db.$transaction.mockImplementation((fn) =>
      fn({
        $queryRaw: db.$queryRaw,
        runEvidence: { count: db.count, create: db.create },
      })
    );
    db.$queryRaw.mockResolvedValue([]);
    db.count.mockResolvedValue(0);
    db.create.mockResolvedValue({ id: 'evidence-1' });
  });

  it('writes the artifact and bounded evidence metadata', async () => {
    const result = await recordRunEvidence({
      body: Buffer.from('12345'),
      caption: 'c'.repeat(501),
      contentType: 'image/png',
      kind: 'screenshot',
      pageUrl: 'p'.repeat(2001),
      runId: 'run-1',
      source: 'agent',
    });

    expect(result).toEqual({ artifactId: 'artifact-1', evidenceId: 'evidence-1', ok: true });
    expect(artifacts.putArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png', kind: 'ui.screenshot', runId: 'run-1' })
    );
    expect(db.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        caption: 'c'.repeat(500),
        pageUrl: 'p'.repeat(2000),
      }),
      select: { id: true },
    });
  });

  it('refuses oversized images before storing an artifact', async () => {
    await expect(
      recordRunEvidence({
        body: Buffer.from('123456'),
        contentType: 'image/png',
        kind: 'screenshot',
        runId: 'run-1',
        source: 'agent',
      })
    ).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(artifacts.putArtifact).not.toHaveBeenCalled();
  });

  it('deletes the staged artifact when the run cap is reached', async () => {
    db.count.mockResolvedValue(2);
    await expect(
      recordRunEvidence({
        body: 'hello',
        contentType: 'text/plain; charset=utf-8',
        kind: 'log',
        runId: 'run-1',
        source: 'uiVerify',
      })
    ).resolves.toEqual({ ok: false, reason: 'run_cap' });
    expect(artifacts.deleteArtifact).toHaveBeenCalledWith('artifact-1');
    expect(db.create).not.toHaveBeenCalled();
  });
});
