import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveStorageConfig: async () => ({
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? null,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    backend: process.env.ARTIFACT_S3_BUCKET ? 's3' : 'inline',
    s3Bucket: process.env.ARTIFACT_S3_BUCKET ?? null,
    s3Endpoint: process.env.ARTIFACT_S3_ENDPOINT ?? null,
    s3ForcePathStyle: false,
    s3Prefix: process.env.ARTIFACT_S3_PREFIX ?? null,
    s3Region: process.env.ARTIFACT_S3_REGION ?? null,
  }),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    workflowArtifact: {
      create: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
  },
}));

const s3 = vi.hoisted(() => ({ sent: [] as { input: Record<string, unknown>; name: string }[] }));
vi.mock('@aws-sdk/client-s3', () => ({
  DeleteObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  S3Client: class {
    send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      s3.sent.push({ input: cmd.input, name: cmd.constructor.name });
      return Promise.resolve({ Body: { transformToByteArray: async () => new Uint8Array() } });
    }
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { deleteArtifact, getArtifact, getArtifactText, putArtifact } from './artifactStore.js';

const createMock = vi.mocked(prisma.workflowArtifact.create);
const deleteMock = vi.mocked(prisma.workflowArtifact.delete);
const findUniqueMock = vi.mocked(prisma.workflowArtifact.findUnique);
const findMock = vi.mocked(prisma.workflowArtifact.findUniqueOrThrow);

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.ARTIFACT_S3_BUCKET;
});

afterEach(() => {
  process.env = { ...originalEnv };
  createMock.mockReset();
  deleteMock.mockReset();
  findUniqueMock.mockReset();
  findMock.mockReset();
  s3.sent.length = 0;
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

describe('deleteArtifact', () => {
  it('deletes a pg-backed artifact by deleting only its row', async () => {
    findUniqueMock.mockResolvedValue({
      backend: 'pg',
      id: 'art-pg',
      s3Key: null,
    } as never);

    await deleteArtifact('art-pg');

    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'art-pg' } });
    expect(s3.sent).toEqual([]);
  });

  it('deletes the S3 object before its row', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    findUniqueMock.mockResolvedValue({
      backend: 's3',
      id: 'art-s3',
      s3Key: 'workflow-artifacts/global/x/y',
    } as never);
    // The object goes first: by the time the row delete runs, the S3 delete
    // must already have been sent.
    deleteMock.mockImplementation((async () => {
      expect(s3.sent).toEqual([
        {
          input: { Bucket: 'bucket-1', Key: 'workflow-artifacts/global/x/y' },
          name: 'DeleteObjectCommand',
        },
      ]);
      return {};
    }) as never);

    await deleteArtifact('art-s3');

    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'art-s3' } });
  });

  it('is a no-op for a row that does not exist', async () => {
    findUniqueMock.mockResolvedValue(null as never);
    await deleteArtifact('missing');
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

// The "SDK is optional" contract this file used to assert (with a test that
// verified the helpful error message when @aws-sdk/client-s3 was missing) was
// retired when the SDK became a hard dependency of the worker — needed by the
// bundled object-store local-dev flow. The error path in artifactStore.ts is
// kept as a defensive fallback but is no longer reachable in normal use.
