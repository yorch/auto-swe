import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    workflowArtifact: {
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { getArtifact, getArtifactText, putArtifact } from './artifactStore.js';

const createMock = vi.mocked(prisma.workflowArtifact.create);
const findMock = vi.mocked(prisma.workflowArtifact.findUniqueOrThrow);

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.ARTIFACT_S3_BUCKET;
});

afterEach(() => {
  process.env = { ...originalEnv };
  createMock.mockReset();
  findMock.mockReset();
});

describe('putArtifact (postgres backend)', () => {
  it('stores text payloads as a UTF-8 blob with sizeBytes', async () => {
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'art-1',
    })) as never);

    const ref = await putArtifact({ body: 'hello world', kind: 'logs' });

    expect(ref).toEqual({
      backend: 'pg',
      contentType: 'application/octet-stream',
      id: 'art-1',
      kind: 'logs',
      sizeBytes: 11,
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.backend).toBe('pg');
    expect(data.inlineBlob).toBeInstanceOf(Uint8Array);
    expect((data.inlineBlob as Uint8Array).byteLength).toBe(11);
  });

  it('honors a runId + contentType override', async () => {
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'art-2',
    })) as never);

    const ref = await putArtifact({
      body: Buffer.from('a'),
      contentType: 'text/plain',
      kind: 'diff',
      runId: 'run-9',
    });

    expect(ref.contentType).toBe('text/plain');
    const data = createMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.runId).toBe('run-9');
  });
});

describe('getArtifact / getArtifactText (postgres backend)', () => {
  it('round-trips a postgres-backed artifact', async () => {
    const payload = Buffer.from('hello world');
    findMock.mockResolvedValue({
      backend: 'pg',
      contentType: 'text/plain',
      id: 'art-1',
      inlineBlob: payload,
      kind: 'logs',
      s3Bucket: null,
      s3Key: null,
      sizeBytes: payload.byteLength,
    } as never);

    const { body, ref } = await getArtifact('art-1');
    expect(ref.backend).toBe('pg');
    expect(ref.id).toBe('art-1');
    expect(body.toString('utf8')).toBe('hello world');

    findMock.mockResolvedValue({
      backend: 'pg',
      contentType: 'text/plain',
      id: 'art-1',
      inlineBlob: payload,
      kind: 'logs',
      s3Bucket: null,
      s3Key: null,
      sizeBytes: payload.byteLength,
    } as never);
    expect(await getArtifactText('art-1')).toBe('hello world');
  });

  it('throws if a pg-backed artifact has no inlineBlob (data corruption)', async () => {
    findMock.mockResolvedValue({
      backend: 'pg',
      contentType: 'text/plain',
      id: 'art-broken',
      inlineBlob: null,
      kind: 'logs',
      s3Bucket: null,
      s3Key: null,
      sizeBytes: 0,
    } as never);

    await expect(getArtifact('art-broken')).rejects.toThrow(/no inlineBlob/);
  });
});

// The "SDK is optional" contract this file used to assert (with a test that
// verified the helpful error message when @aws-sdk/client-s3 was missing) was
// retired when the SDK became a hard dependency of the worker — needed by the
// MinIO local-dev flow added in PR #25. The error path in artifactStore.ts is
// kept as a defensive fallback but is no longer reachable in normal use.
