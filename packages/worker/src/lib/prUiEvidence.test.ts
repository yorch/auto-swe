import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/config/resolveSetting', () => ({ resolveSetting: vi.fn() }));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { runEvidence: { findMany: vi.fn() } },
}));
vi.mock('@auto-swe/shared/lib/artifactStore', () => ({
  getArtifact: vi.fn(),
  putObjectToBucket: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWebUrl: () => 'https://dashboard.example.test/',
}));
vi.mock('./activityLog.js', () => ({ logWarn: vi.fn() }));

import { resolveSetting } from '@auto-swe/shared/config/resolveSetting';
import { prisma } from '@auto-swe/shared/db';
import { getArtifact, putObjectToBucket } from '@auto-swe/shared/lib/artifactStore';
import { buildPrUiEvidence } from './prUiEvidence.js';

const findEvidence = prisma.runEvidence.findMany as unknown as ReturnType<typeof vi.fn>;

function screenshots(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    artifactId: `artifact-${index}`,
    caption: `Page ${index}`,
    id: `evidence-${index}`,
    kind: 'screenshot',
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('UI_EVIDENCE_PUBLIC_BUCKET', '');
  vi.stubEnv('UI_EVIDENCE_PUBLIC_BASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildPrUiEvidence', () => {
  it('returns an empty string when the run has no evidence', async () => {
    findEvidence.mockResolvedValue([]);
    await expect(buildPrUiEvidence('run-1')).resolves.toBe('');
    expect(resolveSetting).not.toHaveBeenCalled();
  });

  it('renders evidence counts and the dashboard link without public copies by default', async () => {
    findEvidence.mockResolvedValue(screenshots(1));
    vi.mocked(resolveSetting).mockResolvedValue(false as never);
    vi.stubEnv('UI_EVIDENCE_PUBLIC_BUCKET', 'public');
    vi.stubEnv('UI_EVIDENCE_PUBLIC_BASE_URL', 'https://cdn.example.test');

    const body = await buildPrUiEvidence('run-1');

    expect(body).toContain('### UI evidence');
    expect(body).toContain('Evidence: 1 screenshot');
    expect(body).toContain('https://dashboard.example.test/runs/run-1#evidence');
    expect(body).not.toContain('![Page');
    expect(putObjectToBucket).not.toHaveBeenCalled();
  });

  it('copies at most six screenshots only when the setting and both public URLs are configured', async () => {
    findEvidence.mockResolvedValue(screenshots(7));
    vi.mocked(resolveSetting).mockResolvedValue(true as never);
    vi.mocked(getArtifact).mockResolvedValue({ body: Buffer.from('png'), ref: {} as never });
    vi.stubEnv('UI_EVIDENCE_PUBLIC_BUCKET', 'public-evidence');
    vi.stubEnv('UI_EVIDENCE_PUBLIC_BASE_URL', 'https://cdn.example.test/');

    const body = await buildPrUiEvidence('run-1');

    expect(putObjectToBucket).toHaveBeenCalledTimes(6);
    expect(putObjectToBucket).toHaveBeenCalledWith(
      'public-evidence',
      'ui-evidence/run-1/evidence-0.png',
      Buffer.from('png'),
      'image/png'
    );
    expect(body.match(/!\[/g)).toHaveLength(6);
  });
});
