import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveStorageConfig: async () => {
    const fsDir = process.env.ARTIFACT_FS_DIR?.trim() || null;
    const bucket = process.env.ARTIFACT_S3_BUCKET || null;
    return {
      awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? null,
      awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? null,
      fsDir,
      s3Bucket: bucket,
      s3Endpoint: process.env.ARTIFACT_S3_ENDPOINT ?? null,
      s3ForcePathStyle: false,
      s3Prefix: process.env.ARTIFACT_S3_PREFIX ?? null,
      s3Region: process.env.ARTIFACT_S3_REGION ?? null,
      writeBackend: process.env.ARTIFACT_WRITE_BACKEND || (fsDir ? 'fs' : bucket ? 's3' : 'pg'),
    };
  },
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    workflowArtifact: {
      count: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workflowArtifactChunk: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const s3 = vi.hoisted(() => ({
  fail: null as null | { command: string; error: unknown },
  payload: Buffer.alloc(0),
  sent: [] as { input: Record<string, unknown>; name: string }[],
}));
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
      if (s3.fail && s3.fail.command === cmd.constructor.name) {
        return Promise.reject(s3.fail.error);
      }
      const payload = s3.payload;
      return Promise.resolve({ Body: Readable.from([payload]), ContentLength: payload.byteLength });
    }
  },
}));

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '@auto-swe/shared/db';
import { FS_STORE_MARKER, readFsStoreMarker } from './artifactFsStore.js';
import {
  assertArtifactStorageReady,
  deleteArtifact,
  deletePendingArtifact,
  getArtifact,
  getArtifactStream,
  getArtifactText,
  putArtifact,
  sweepArtifactTempFiles,
} from './artifactStore.js';

const createMock = vi.mocked(prisma.workflowArtifact.create);
const countMock = vi.mocked(prisma.workflowArtifact.count);
const deleteMock = vi.mocked(prisma.workflowArtifact.delete);
const deleteManyMock = vi.mocked(prisma.workflowArtifact.deleteMany);
const updateMock = vi.mocked(prisma.workflowArtifact.update);
const updateManyMock = vi.mocked(prisma.workflowArtifact.updateMany);
const findUniqueMock = vi.mocked(prisma.workflowArtifact.findUnique);
const findMock = vi.mocked(prisma.workflowArtifact.findUniqueOrThrow);
const chunkCreateMock = vi.mocked(prisma.workflowArtifactChunk.create);
const chunkFindManyMock = vi.mocked(prisma.workflowArtifactChunk.findMany);

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.ARTIFACT_S3_BUCKET;
  delete process.env.ARTIFACT_FS_DIR;
  delete process.env.ARTIFACT_WRITE_BACKEND;
});

afterEach(() => {
  process.env = { ...originalEnv };
  createMock.mockReset();
  countMock.mockReset();
  deleteMock.mockReset();
  deleteManyMock.mockReset();
  updateMock.mockReset();
  updateManyMock.mockReset();
  updateManyMock.mockResolvedValue({ count: 1 } as never);
  findUniqueMock.mockReset();
  findMock.mockReset();
  chunkCreateMock.mockReset();
  chunkFindManyMock.mockReset();
  s3.sent.length = 0;
  s3.fail = null;
  s3.payload = Buffer.alloc(0);
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

  it('writes file bodies as 1 MiB chunks and reads them back byte-identically', async () => {
    const filePath = path.join(os.tmpdir(), `asw-artifact-${process.pid}.pg`);
    const payload = Buffer.alloc(1024 * 1024 + 37, 0xa7);
    await fs.writeFile(filePath, payload);
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'art-file-pg',
    })) as never);
    updateManyMock.mockResolvedValue({ count: 1 } as never);
    const chunks: { data: Buffer; seq: number }[] = [];
    chunkCreateMock.mockImplementation((async ({
      data,
    }: {
      data: { data: Uint8Array; seq: number };
    }) => {
      chunks.push({ data: Buffer.from(data.data), seq: data.seq });
      return data;
    }) as never);
    chunkFindManyMock.mockImplementation((async ({ where }: { where: { seq: { gte: number } } }) =>
      chunks.filter((chunk) => chunk.seq >= where.seq.gte).slice(0, 4)) as never);

    try {
      const ref = await putArtifact({
        body: { filePath, sizeBytes: payload.byteLength },
        kind: 'ui.video',
      });

      expect(ref.sizeBytes).toBe(payload.byteLength);
      const data = createMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
      expect(data).toMatchObject({ inlineBlob: null, status: 'pending' });
      expect(chunks.map(({ data: chunk, seq }) => [seq, chunk.byteLength])).toEqual([
        [0, 1024 * 1024],
        [1, 37],
      ]);
      expect(updateManyMock).toHaveBeenCalledWith({
        data: { status: 'ready' },
        where: { id: 'art-file-pg', status: 'pending' },
      });

      findMock.mockResolvedValue({
        backend: 'pg',
        contentType: 'application/octet-stream',
        id: 'art-file-pg',
        inlineBlob: null,
        kind: 'ui.video',
        sizeBytes: payload.byteLength,
        status: 'ready',
      } as never);
      const { body, ref: readRef } = await getArtifact('art-file-pg');
      expect(body).toEqual(payload);
      expect(readRef.sizeBytes).toBe(payload.byteLength);
      expect(chunkFindManyMock).toHaveBeenCalledWith(
        expect.objectContaining({ take: 4, where: { artifactId: 'art-file-pg', seq: { gte: 0 } } })
      );
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('rejects and deletes a pending chunked row when the file size does not match', async () => {
    const filePath = path.join(os.tmpdir(), `asw-artifact-${process.pid}.bad-size.pg`);
    const payload = Buffer.from('recording bytes');
    await fs.writeFile(filePath, payload);
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'art-file-bad-size',
    })) as never);
    findUniqueMock.mockResolvedValue({ backend: 'pg', status: 'pending' } as never);
    deleteManyMock.mockResolvedValue({ count: 1 } as never);

    try {
      await expect(
        putArtifact({
          body: { filePath, sizeBytes: payload.byteLength + 1 },
          kind: 'ui.video',
        })
      ).rejects.toThrow(/size mismatch/);
      expect(chunkCreateMock).toHaveBeenCalledOnce();
      expect(updateManyMock).toHaveBeenCalledWith({
        data: { status: 'pruning' },
        where: { id: 'art-file-bad-size', status: 'pending' },
      });
      expect(deleteManyMock).toHaveBeenCalledWith({
        where: { id: 'art-file-bad-size', status: 'pruning' },
      });
    } finally {
      await fs.rm(filePath, { force: true });
    }
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
      status: 'ready',
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
      status: 'ready',
    } as never);
    expect(await getArtifactText('art-1')).toBe('hello world');
  });

  it('throws if a chunked pg artifact has missing chunks', async () => {
    findMock.mockResolvedValue({
      backend: 'pg',
      contentType: 'text/plain',
      id: 'art-broken',
      inlineBlob: null,
      kind: 'logs',
      sizeBytes: 1,
      status: 'ready',
    } as never);
    chunkFindManyMock.mockResolvedValue([] as never);

    await expect(getArtifact('art-broken')).rejects.toThrow(/size mismatch/);
  });
});

describe('getArtifactStream (S3 and Postgres)', () => {
  it('returns the S3 body stream and its length', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    s3.payload = Buffer.from('aws-bytes');
    findMock.mockResolvedValue({
      backend: 's3',
      contentType: 'text/plain',
      id: 'art-s3',
      kind: 'logs',
      s3Bucket: 'bucket-1',
      s3Key: 'workflow-artifacts/global/logs/x',
      sizeBytes: 9,
      status: 'ready',
    } as never);

    const { sizeBytes, stream } = await getArtifactStream('art-s3');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }

    expect(sizeBytes).toBe(9);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('aws-bytes');
  });

  it('streams a Postgres blob', async () => {
    findMock.mockResolvedValue({
      backend: 'pg',
      contentType: 'text/plain',
      id: 'art-pg',
      inlineBlob: Buffer.from('pg-bytes'),
      kind: 'logs',
      sizeBytes: 8,
      status: 'ready',
    } as never);

    const { sizeBytes, stream } = await getArtifactStream('art-pg');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }

    expect(sizeBytes).toBe(8);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('pg-bytes');
  });

  it('refuses a row that is not ready before opening a stream', async () => {
    findMock.mockResolvedValue({
      backend: 'pg',
      id: 'art-pending',
      inlineBlob: Buffer.from('x'),
      kind: 'logs',
      sizeBytes: 1,
      status: 'pending',
    } as never);

    await expect(getArtifactStream('art-pending')).rejects.toThrow(/not ready/);
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
      s3Bucket: 'bucket-1',
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

describe('putArtifact (S3 backend, write-ahead)', () => {
  it('writes the row pending, then the object, then marks the row ready', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    const order: string[] = [];
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
      order.push(`create:${data.status}`);
      // No object may exist yet when the row is created.
      expect(s3.sent).toEqual([]);
      return { ...data, id: 'art-s3' };
    }) as never);
    updateManyMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
      order.push(`update:${data.status}`);
      expect(s3.sent.map((c) => c.name)).toEqual(['PutObjectCommand']);
      return { count: 1 };
    }) as never);

    const ref = await putArtifact({ body: 'payload', kind: 'logs' });

    expect(order).toEqual(['create:pending', 'update:ready']);
    const data = createMock.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    // The row carries the key the object is written under.
    expect(data.s3Key).toBe(s3.sent[0]?.input.Key);
    expect(updateManyMock).toHaveBeenCalledWith({
      data: { status: 'ready' },
      where: { id: 'art-s3', status: 'pending' },
    });
    expect(ref).toMatchObject({ backend: 's3', id: 'art-s3' });
  });

  it('streams file bodies with an explicit ContentLength', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    const filePath = path.join(os.tmpdir(), `asw-artifact-${process.pid}.s3`);
    const payload = Buffer.from('streamed video');
    await fs.writeFile(filePath, payload);
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'art-s3-file',
    })) as never);

    try {
      const ref = await putArtifact({
        body: { filePath, sizeBytes: payload.byteLength },
        kind: 'ui.video',
      });
      const put = s3.sent.find((command) => command.name === 'PutObjectCommand');
      const body = put?.input.Body;
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }

      expect(ref.sizeBytes).toBe(payload.byteLength);
      expect(body).toBeInstanceOf(Readable);
      expect(put?.input.ContentLength).toBe(payload.byteLength);
      expect(Buffer.concat(chunks)).toEqual(payload);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('leaves its row pending and rethrows when PutObject fails', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'art-fail',
    })) as never);
    s3.fail = { command: 'PutObjectCommand', error: new Error('store down') };

    await expect(putArtifact({ body: 'payload', kind: 'logs' })).rejects.toThrow('store down');

    // The store may have committed the object anyway: the pending row is what
    // lets the sweep find and delete it, so it must survive the failure.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('refuses to publish a row retention claimed, and removes the object', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      id: 'art-claimed',
    })) as never);
    updateManyMock.mockResolvedValue({ count: 0 } as never);

    await expect(putArtifact({ body: 'payload', kind: 'logs' })).rejects.toThrow(
      /claimed by retention/
    );
    expect(s3.sent.map((c) => c.name)).toEqual(['PutObjectCommand', 'DeleteObjectCommand']);
  });
});

describe('getArtifact refuses an artifact that is not ready', () => {
  it('throws for a pending row without touching the store', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    findMock.mockResolvedValue({
      backend: 's3',
      contentType: 'text/plain',
      id: 'art-pending',
      inlineBlob: null,
      kind: 'logs',
      s3Bucket: 'bucket-1',
      s3Key: 'workflow-artifacts/global/logs/x',
      sizeBytes: 1,
      status: 'pending',
    } as never);

    await expect(getArtifact('art-pending')).rejects.toThrow(/not ready/);
    expect(s3.sent).toEqual([]);
  });
});

describe('deletePendingArtifact', () => {
  it('deletes pending pg rows so their chunks cascade', async () => {
    findUniqueMock.mockResolvedValue({ backend: 'pg', status: 'pending' } as never);
    deleteManyMock.mockResolvedValue({ count: 1 } as never);

    await expect(deletePendingArtifact('art-pg-pending')).resolves.toBe(true);

    expect(updateManyMock).toHaveBeenCalledWith({
      data: { status: 'pruning' },
      where: { id: 'art-pg-pending', status: 'pending' },
    });
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: 'art-pg-pending', status: 'pruning' },
    });
  });

  it('deletes the object, then the row while it is still pending', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    findUniqueMock.mockResolvedValue({
      backend: 's3',
      s3Key: 'workflow-artifacts/global/x/y',
      status: 'pending',
    } as never);
    deleteManyMock.mockImplementation((async () => {
      // The row is claimed before the payload is touched, so a writer resuming
      // late cannot publish it mid-delete.
      expect(updateManyMock).toHaveBeenCalledWith({
        data: { status: 'pruning' },
        where: { id: 'art-p', status: 'pending' },
      });
      expect(s3.sent.map((c) => c.name)).toEqual(['DeleteObjectCommand']);
      return { count: 1 };
    }) as never);

    expect(await deletePendingArtifact('art-p')).toBe(true);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: 'art-p', status: 'pruning' } });
  });

  it('treats a missing object as deleted', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    findUniqueMock.mockResolvedValue({
      backend: 's3',
      s3Key: 'workflow-artifacts/global/x/y',
      status: 'pending',
    } as never);
    s3.fail = {
      command: 'DeleteObjectCommand',
      error: Object.assign(new Error('gone'), { name: 'NoSuchKey' }),
    };
    deleteManyMock.mockResolvedValue({ count: 1 } as never);

    expect(await deletePendingArtifact('art-p')).toBe(true);
  });

  it('keeps the row when the object delete fails for another reason', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    findUniqueMock.mockResolvedValue({
      backend: 's3',
      s3Key: 'workflow-artifacts/global/x/y',
      status: 'pending',
    } as never);
    s3.fail = { command: 'DeleteObjectCommand', error: new Error('store down') };

    await expect(deletePendingArtifact('art-p')).rejects.toThrow('store down');
    // The claim stays, so the next sweep retries and the writer cannot publish.
    expect(updateManyMock).toHaveBeenCalledWith({
      data: { status: 'pruning' },
      where: { id: 'art-p', status: 'pending' },
    });
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('retries a claim a previous sweep left behind', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    findUniqueMock.mockResolvedValue({
      backend: 's3',
      s3Key: 'workflow-artifacts/global/x/y',
      status: 'pruning',
    } as never);
    deleteManyMock.mockResolvedValue({ count: 1 } as never);

    expect(await deletePendingArtifact('art-p')).toBe(true);
    expect(updateManyMock).toHaveBeenCalledWith({
      data: { status: 'pruning' },
      where: { id: 'art-p', status: 'pruning' },
    });
  });

  it('does nothing when another sweep already claimed the row', async () => {
    process.env.ARTIFACT_S3_BUCKET = 'bucket-1';
    findUniqueMock.mockResolvedValue({
      backend: 's3',
      s3Key: 'workflow-artifacts/global/x/y',
      status: 'pending',
    } as never);
    updateManyMock.mockResolvedValue({ count: 0 } as never);

    expect(await deletePendingArtifact('art-p')).toBe(false);
    expect(s3.sent).toEqual([]);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it('leaves a ready row alone', async () => {
    findUniqueMock.mockResolvedValue({ backend: 's3', s3Key: 'k', status: 'ready' } as never);
    expect(await deletePendingArtifact('art-r')).toBe(false);
    expect(s3.sent).toEqual([]);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});

// The "SDK is optional" contract this file used to assert (with a test that
// verified the helpful error message when @aws-sdk/client-s3 was missing) was
// retired when the SDK became a hard dependency of the worker — needed by the
// bundled object-store local-dev flow. The error path in artifactStore.ts is
// kept as a defensive fallback but is no longer reachable in normal use.

describe('filesystem backend', () => {
  let root = '';
  const runId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-artifacts-'));
    process.env.ARTIFACT_FS_DIR = root;
    process.env.ARTIFACT_WRITE_BACKEND = 'fs';
    createMock.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
    })) as never);
    updateManyMock.mockResolvedValue({ count: 1 } as never);
    deleteMock.mockResolvedValue({} as never);
    deleteManyMock.mockResolvedValue({ count: 1 } as never);
  });

  afterEach(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  async function putOne(kind = 'ui.log', body = 'hello') {
    const ref = await putArtifact({ body, kind, runId });
    const data = createMock.mock.calls.at(-1)?.[0]?.data as Record<string, string>;
    return { data, ref };
  }

  it('writes the payload under the store with its own identity', async () => {
    const { data, ref } = await putOne();

    expect(ref.backend).toBe('fs');
    expect(data.backend).toBe('fs');
    expect(data.status).toBe('pending');
    expect(data.fsPath).toBe(`${runId}/ui.log/${data.id}`);
    expect(data.fsStoreId).toMatch(/^[0-9a-f-]{36}$/);
    const marker = await readFsStoreMarker(root);
    expect(marker?.storeId).toBe(data.fsStoreId);
    expect(await fs.readFile(path.join(root, data.fsPath), 'utf8')).toBe('hello');
    expect((await fs.stat(path.join(root, data.fsPath))).mode & 0o777).toBe(0o600);
    expect(updateManyMock).toHaveBeenCalledWith({
      data: { status: 'ready' },
      where: { id: data.id, status: 'pending' },
    });
  });

  it('streams file bodies into the filesystem store', async () => {
    const sourcePath = path.join(root, 'source.webm');
    const payload = Buffer.from('streamed recording');
    await fs.writeFile(sourcePath, payload);

    const ref = await putArtifact({
      body: { filePath: sourcePath, sizeBytes: payload.byteLength },
      kind: 'ui.video',
      runId,
    });

    const data = createMock.mock.calls.at(-1)?.[0]?.data as Record<string, string | number>;
    expect(ref.sizeBytes).toBe(payload.byteLength);
    expect(data.sizeBytes).toBe(payload.byteLength);
    expect(await fs.readFile(path.join(root, String(data.fsPath)))).toEqual(payload);
  });

  it('round-trips through getArtifact', async () => {
    const { data } = await putOne('ui.screenshot', 'png-bytes');
    findMock.mockResolvedValue({ ...data, status: 'ready' } as never);

    const { body, ref } = await getArtifact(String(data.id));

    expect(ref.backend).toBe('fs');
    expect(body.toString('utf8')).toBe('png-bytes');
  });

  it('streams a filesystem artifact without buffering it first', async () => {
    const { data } = await putOne('ui.video', 'video-bytes');
    findMock.mockResolvedValue({ ...data, status: 'ready' } as never);

    const { sizeBytes, stream } = await getArtifactStream(String(data.id));
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }

    expect(sizeBytes).toBe(11);
    expect(Buffer.concat(chunks).toString('utf8')).toBe('video-bytes');
  });

  it('deletes the file, then the row', async () => {
    const { data } = await putOne();
    const file = path.join(root, data.fsPath);
    findUniqueMock.mockResolvedValue({ ...data, status: 'ready' } as never);

    await deleteArtifact(String(data.id));

    await expect(fs.access(file)).rejects.toThrow();
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: data.id } });
  });

  it('refuses a directory that is a different store, and keeps the row', async () => {
    const { data } = await putOne();
    await fs.writeFile(
      path.join(root, FS_STORE_MARKER),
      `${JSON.stringify({ storeId: '22222222-2222-4222-8222-222222222222', version: 1 })}\n`
    );
    findMock.mockResolvedValue({ ...data, status: 'ready' } as never);
    findUniqueMock.mockResolvedValue({ ...data, status: 'ready' } as never);

    await expect(getArtifact(String(data.id))).rejects.toThrow(/different store/);
    await expect(deleteArtifact(String(data.id))).rejects.toThrow(/different store/);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('removes the file it just wrote when retention claimed the row first', async () => {
    updateManyMock.mockResolvedValue({ count: 0 } as never);

    await expect(putArtifact({ body: 'x', kind: 'ui.log', runId })).rejects.toThrow(
      /claimed by retention/
    );
    const data = createMock.mock.calls.at(-1)?.[0]?.data as Record<string, string>;
    await expect(fs.access(path.join(root, data.fsPath))).rejects.toThrow();
  });

  it('removes the final file and an in-flight temporary when reaping a pending row', async () => {
    const { data } = await putOne();
    const temp = path.join(root, '.tmp', `${data.id}.part`);
    await fs.writeFile(temp, 'partial');
    findUniqueMock.mockResolvedValue({ ...data, status: 'pending' } as never);

    expect(await deletePendingArtifact(String(data.id))).toBe(true);

    await expect(fs.access(path.join(root, data.fsPath))).rejects.toThrow();
    await expect(fs.access(temp)).rejects.toThrow();
    expect(deleteManyMock).toHaveBeenCalledWith({
      where: { id: data.id, status: 'pruning' },
    });
  });

  it('sweeps abandoned temporaries by age and leaves fresh ones', async () => {
    const tempDir = path.join(root, '.tmp');
    await fs.mkdir(tempDir, { recursive: true });
    const old = path.join(tempDir, 'old.part');
    const fresh = path.join(tempDir, 'fresh.part');
    await fs.writeFile(old, 'x');
    await fs.writeFile(fresh, 'x');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(old, twoDaysAgo, twoDaysAgo);

    expect(await sweepArtifactTempFiles(24 * 60 * 60 * 1000)).toBe(1);
    await expect(fs.access(old)).rejects.toThrow();
    await expect(fs.access(fresh)).resolves.toBeUndefined();
  });

  it('refuses a symlinked parent instead of reading through it', async () => {
    const { data } = await putOne();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-outside-'));
    const file = path.join(root, data.fsPath);
    await fs.rename(file, path.join(outside, path.basename(file)));
    await fs.rm(path.join(root, runId), { force: true, recursive: true });
    await fs.symlink(outside, path.join(root, runId));
    findMock.mockResolvedValue({ ...data, status: 'ready' } as never);

    await expect(getArtifact(String(data.id))).rejects.toThrow(/symlink/);
    await fs.rm(outside, { force: true, recursive: true });
  });

  it('rejects a path component that could leave the layout', async () => {
    await expect(putArtifact({ body: 'x', kind: '..', runId })).rejects.toThrow(
      'invalid artifact kind'
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a row whose backend it does not know', async () => {
    findMock.mockResolvedValue({
      backend: 'tape',
      id: 'art-1',
      kind: 'logs',
      sizeBytes: 1,
      status: 'ready',
    } as never);

    await expect(getArtifact('art-1')).rejects.toThrow('unknown backend "tape"');
  });

  describe('assertArtifactStorageReady', () => {
    it('refuses a directory with no marker when rows say the store has artifacts', async () => {
      countMock.mockResolvedValue(3);

      await expect(assertArtifactStorageReady('gateway')).rejects.toThrow(/no \.auto-swe/);
    });

    it('refuses a marker that does not match the stored rows', async () => {
      await putOne();
      countMock.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
      await fs.writeFile(
        path.join(root, FS_STORE_MARKER),
        `${JSON.stringify({ storeId: '22222222-2222-4222-8222-222222222222', version: 1 })}\n`
      );

      await expect(assertArtifactStorageReady('worker')).rejects.toThrow(
        /different filesystem store/
      );
    });

    it('creates the store for a worker when no artifact exists yet', async () => {
      await fs.rm(root, { force: true, recursive: true });
      countMock.mockResolvedValue(0);

      await assertArtifactStorageReady('worker');

      expect((await readFsStoreMarker(root))?.storeId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(fs.readdir(path.join(root, '.tmp'))).resolves.toEqual([]);
    });

    it('lets a gateway start before the first write', async () => {
      await fs.rm(root, { force: true, recursive: true });
      countMock.mockResolvedValue(0);

      await expect(assertArtifactStorageReady('gateway')).resolves.toBeUndefined();
      await expect(fs.access(path.join(root, FS_STORE_MARKER))).rejects.toThrow();
    });
  });
});
