/**
 * Artifact store — keeps large step outputs (diffs, logs, scan reports, run
 * evidence, transcripts) out of the workflow context object so we stay under
 * Temporal's 50MB history cap.
 *
 * Three backends:
 *   - "s3" : any S3-compatible object store — the bundled Garage container,
 *            AWS S3, R2, B2. Loads @aws-sdk/client-s3 lazily. Only PutObject,
 *            GetObject and DeleteObject are used.
 *   - "fs" : a directory the operator mounts into every process that reads
 *            artifacts — the worker writes, the gateway serves evidence and
 *            transcripts from it. ENOSPC and a wrong mount are the failure
 *            modes; `artifactFsStore.ts` owns the layout and the store identity.
 *   - "pg" : Postgres BYTEA column on workflow_artifacts. Default for local dev
 *            so contributors need no object store running at all.
 *
 * New artifacts go to `ARTIFACT_WRITE_BACKEND` (derived from `ARTIFACT_FS_DIR` /
 * `ARTIFACT_S3_BUCKET` when unset). Reads dispatch on the row's own backend, so a
 * deployment that switches its writes still serves what it wrote before — and a
 * backend whose configuration has gone away fails loudly rather than silently
 * deleting rows.
 *
 * The interpreter passes artifact IDs through the run context. Activities call
 * getArtifact(id) to materialize the payload on demand.
 */

import { prisma } from '../db.js';
import {
  artifactRelativePath,
  assertFsStore,
  deleteFsArtifact,
  ensureFsStore,
  FS_STORE_MARKER,
  probeFsStore,
  readFsArtifact,
  readFsStoreMarker,
  sweepArtifactTempFiles as sweepStoreTempFiles,
  writeFsArtifact,
} from './artifactFsStore.js';
import { resolveStorageConfig } from './systemConfig.js';

export type ArtifactBackend = 's3' | 'pg' | 'fs';

export interface ArtifactRef {
  id: string;
  kind: string;
  contentType: string;
  sizeBytes: number;
  backend: ArtifactBackend;
}

export interface PutArtifactInput {
  runId?: string;
  kind: string;
  contentType?: string;
  body: Buffer | string;
}

function copyToUint8Array(buf: Buffer): Uint8Array<ArrayBuffer> {
  const ab: ArrayBuffer = new ArrayBuffer(buf.byteLength);
  const out = new Uint8Array(ab);
  out.set(buf);
  return out as Uint8Array<ArrayBuffer>;
}

// Lazy-loaded S3 client. Worker images that never touch S3 don't need the SDK,
// and we don't want @aws-sdk/client-s3 in the dependency graph by default.
// When ARTIFACT_S3_BUCKET is set the operator is expected to install the SDK.
interface S3Helper {
  putObject(key: string, body: Buffer, contentType: string, bucket: string): Promise<void>;
  getObject(key: string, bucket: string): Promise<Buffer>;
  deleteObject(key: string, bucket: string): Promise<void>;
}
let s3ClientPromise: Promise<S3Helper> | null = null;

async function s3Client(): Promise<S3Helper> {
  if (s3ClientPromise) {
    return s3ClientPromise;
  }
  s3ClientPromise = (async () => {
    // Use a dynamic specifier so TS doesn't try to resolve the type at compile time.
    const moduleName = '@aws-sdk/client-s3';
    const mod = (await import(/* @vite-ignore */ moduleName).catch(() => null)) as unknown as {
      S3Client: new (
        cfg: Record<string, unknown>
      ) => {
        send: (cmd: unknown) => Promise<{
          Body?: { transformToByteArray(): Promise<Uint8Array> };
        }>;
      };
      PutObjectCommand: new (input: Record<string, unknown>) => unknown;
      GetObjectCommand: new (input: Record<string, unknown>) => unknown;
      DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
    } | null;
    if (!mod) {
      throw new Error(
        '@aws-sdk/client-s3 not installed but S3 storage backend is active. ' +
          'Run `yarn workspace @auto-swe/worker add @aws-sdk/client-s3`.'
      );
    }
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = mod;
    const storageCfg = await resolveStorageConfig();
    const region = storageCfg.s3Region ?? 'us-east-1';
    const endpoint = storageCfg.s3Endpoint ?? undefined;
    const forcePathStyle = storageCfg.s3ForcePathStyle;
    const client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle } : {}),
    });
    return {
      async deleteObject(key, bucket) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      },
      async getObject(key, bucket) {
        const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!resp.Body) {
          throw new Error(`artifact body missing for s3://${bucket}/${key}`);
        }
        const bytes = await resp.Body.transformToByteArray();
        // Copy into a fresh Buffer/ArrayBuffer to satisfy strict typing on
        // Node's evolving Buffer types (avoids the SharedArrayBuffer mismatch).
        return Buffer.from(new Uint8Array(bytes));
      },
      async putObject(key, body, contentType, bucket) {
        await client.send(
          new PutObjectCommand({ Body: body, Bucket: bucket, ContentType: contentType, Key: key })
        );
      },
    };
  })();
  return s3ClientPromise;
}

/** The configured filesystem store, or a clear error naming the missing setting. */
async function fsStoreRoot(operation: string): Promise<string> {
  const cfg = await resolveStorageConfig();
  if (!cfg.fsDir) {
    throw new Error(
      `this artifact lives in the filesystem store, but ARTIFACT_FS_DIR is not set (${operation})`
    );
  }
  return cfg.fsDir;
}

async function putFsArtifact(
  input: PutArtifactInput,
  body: Buffer,
  contentType: string
): Promise<ArtifactRef> {
  const root = await fsStoreRoot('putArtifact');
  const id = crypto.randomUUID();
  const relativePath = artifactRelativePath({ id, kind: input.kind, runId: input.runId });
  const marker = await ensureFsStore(root);

  // Write-ahead like S3: the pending row exists before the payload, so a
  // process killed mid-write leaves a row the daily sweep can find.
  const row = await prisma.workflowArtifact.create({
    data: {
      backend: 'fs',
      contentType,
      fsPath: relativePath,
      fsStoreId: marker.storeId,
      id,
      kind: input.kind,
      runId: input.runId,
      sizeBytes: body.byteLength,
      status: 'pending',
    },
  });
  try {
    await writeFsArtifact({ body, relativePath, root });
  } catch (error) {
    // Nothing was published: drop the row so the sweep has no phantom to retry.
    await prisma.workflowArtifact
      .deleteMany({ where: { id: row.id, status: 'pending' } })
      .catch(() => undefined);
    throw error;
  }
  // If this fails the file is already in place and the row stays pending: the
  // sweep deletes both after a day rather than leaving an untracked object.
  await prisma.workflowArtifact.update({ data: { status: 'ready' }, where: { id: row.id } });
  return {
    backend: 'fs',
    contentType,
    id: row.id,
    kind: input.kind,
    sizeBytes: body.byteLength,
  };
}

export async function putArtifact(input: PutArtifactInput): Promise<ArtifactRef> {
  const cfg = await resolveStorageConfig();
  const contentType = input.contentType ?? 'application/octet-stream';
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;

  if (cfg.writeBackend === 'fs') {
    return putFsArtifact(input, body, contentType);
  }

  if (cfg.writeBackend === 's3') {
    if (!cfg.s3Bucket) {
      throw new Error(
        'S3 backend is active but s3Bucket is not configured. Set it at /admin/integrations → Storage.'
      );
    }
    const bucket = cfg.s3Bucket;
    const prefix = cfg.s3Prefix ?? 'workflow-artifacts';
    const key = `${prefix}/${input.runId ?? 'global'}/${input.kind}/${crypto.randomUUID()}`;
    const client = await s3Client();
    // Write-ahead: the row (with its key) exists before the object does, so an
    // object whose writer died between the two is still named by a `pending`
    // row the transcript sweep can find and delete. A failed upload leaves its
    // row pending too — the store may have committed the object even though
    // the call failed — and the sweep reaps object, then row.
    const row = await prisma.workflowArtifact.create({
      data: {
        backend: 's3',
        contentType,
        kind: input.kind,
        runId: input.runId,
        s3Bucket: bucket,
        s3Key: key,
        sizeBytes: body.byteLength,
        status: 'pending',
      },
    });
    await client.putObject(key, body, contentType, bucket);
    await prisma.workflowArtifact.update({ data: { status: 'ready' }, where: { id: row.id } });
    return { backend: 's3', contentType, id: row.id, kind: input.kind, sizeBytes: body.byteLength };
  }

  const row = await prisma.workflowArtifact.create({
    data: {
      backend: 'pg',
      contentType,
      // Prisma's Bytes maps to Uint8Array<ArrayBuffer>; copy through a fresh
      // ArrayBuffer to ensure the underlying buffer is not a SharedArrayBuffer.
      inlineBlob: copyToUint8Array(body),
      kind: input.kind,
      runId: input.runId,
      sizeBytes: body.byteLength,
    },
  });
  return { backend: 'pg', contentType, id: row.id, kind: input.kind, sizeBytes: body.byteLength };
}

export async function getArtifact(id: string): Promise<{ ref: ArtifactRef; body: Buffer }> {
  const row = await prisma.workflowArtifact.findUniqueOrThrow({ where: { id } });
  if (row.status !== 'ready') {
    throw new Error(`artifact ${id} is not ready (status=${row.status})`);
  }
  const ref: ArtifactRef = {
    backend: row.backend as ArtifactBackend,
    contentType: row.contentType,
    id: row.id,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
  };
  if (row.backend === 's3') {
    if (!row.s3Key) {
      throw new Error(`artifact ${id} has backend=s3 but no s3Key`);
    }
    const client = await s3Client();
    const body = await client.getObject(row.s3Key, row.s3Bucket ?? '');
    return { body, ref };
  }
  if (row.backend === 'fs') {
    if (!row.fsPath) {
      throw new Error(`artifact ${id} has backend=fs but no fsPath`);
    }
    const root = await fsStoreRoot('getArtifact');
    await assertFsStore(root, row.fsStoreId);
    return { body: await readFsArtifact({ relativePath: row.fsPath, root }), ref };
  }
  if (row.backend !== 'pg') {
    throw new Error(`artifact ${id} has unknown backend "${row.backend}"`);
  }
  if (!row.inlineBlob) {
    throw new Error(`artifact ${id} has backend=pg but no inlineBlob`);
  }
  return { body: Buffer.from(row.inlineBlob), ref };
}

/**
 * Delete an artifact: its payload first, then the row. The payload goes first so
 * a row-removal failure leaves a re-tryable orphan the transcript sweep's
 * pending pass can find, rather than a row pointing at nothing.
 */
export async function deleteArtifact(id: string): Promise<void> {
  const row = await prisma.workflowArtifact.findUnique({ where: { id } });
  if (!row) {
    return;
  }
  if (row.backend === 's3' && row.s3Key) {
    const client = await s3Client();
    await client.deleteObject(row.s3Key, row.s3Bucket ?? '');
  } else if (row.backend === 'fs') {
    if (row.fsPath) {
      const root = await fsStoreRoot('deleteArtifact');
      // Fail closed on a wrong mount before ENOENT can pass for "already gone".
      await assertFsStore(root, row.fsStoreId);
      await deleteFsArtifact({ relativePath: row.fsPath, root });
    }
  } else if (row.backend !== 'pg') {
    throw new Error(`artifact ${id} has unknown backend "${row.backend}"`);
  }
  await prisma.workflowArtifact.delete({ where: { id } });
}

export async function putObjectToBucket(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  if (!bucket.trim() || !key.trim()) {
    throw new Error('S3 bucket and object key are required');
  }
  await (await s3Client()).putObject(key, body, contentType, bucket);
}

/**
 * Delete one object written by {@link putObjectToBucket}. A key that is already
 * gone counts as deleted, so a retention sweep can call this without tracking
 * every successful write.
 */
export async function deleteObjectFromBucket(bucket: string, key: string): Promise<void> {
  if (!bucket.trim() || !key.trim()) {
    throw new Error('S3 bucket and object key are required');
  }
  try {
    await (await s3Client()).deleteObject(key, bucket);
  } catch (error) {
    if (!isMissingObject(error)) {
      throw error;
    }
  }
}

/** True for the "no such key" answers an S3-compatible store gives. */
function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.Code === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Delete a `pending` artifact: a write that never completed. The payload goes
 * first and a missing one counts as deleted (the write may never have landed);
 * then the row, only while it is still pending. Returns whether a row was
 * removed.
 */
export async function deletePendingArtifact(id: string): Promise<boolean> {
  const row = await prisma.workflowArtifact.findUnique({
    select: {
      backend: true,
      fsPath: true,
      fsStoreId: true,
      s3Bucket: true,
      s3Key: true,
      status: true,
    },
    where: { id },
  });
  if (row?.status !== 'pending') {
    return false;
  }
  if (row.backend === 's3' && row.s3Key) {
    const client = await s3Client();
    try {
      await client.deleteObject(row.s3Key, row.s3Bucket ?? '');
    } catch (err) {
      if (!isMissingObject(err)) {
        throw err;
      }
    }
  } else if (row.backend === 'fs' && row.fsPath) {
    const root = await fsStoreRoot('deletePendingArtifact');
    await assertFsStore(root, row.fsStoreId);
    await deleteFsArtifact({ relativePath: row.fsPath, root });
  } else if (row.backend !== 'pg') {
    throw new Error(`artifact ${id} has unknown backend "${row.backend}"`);
  }
  const { count } = await prisma.workflowArtifact.deleteMany({
    where: { id, status: 'pending' },
  });
  return count > 0;
}

/**
 * Delete abandoned in-flight temporary files. A writer killed between creating
 * its temporary and renaming it leaves one, and no row names it; the daily
 * transcript sweep calls this. A no-op without a filesystem store.
 */
export async function sweepArtifactTempFiles(olderThanMs: number, now?: number): Promise<number> {
  const cfg = await resolveStorageConfig();
  if (!cfg.fsDir) {
    return 0;
  }
  return sweepStoreTempFiles(cfg.fsDir, olderThanMs, now);
}

/**
 * Fail a process's boot when its filesystem store is not the one the database
 * expects. Called by the gateway (read side) and the worker (read/write side).
 *
 * - A fresh store with no rows may be created by the worker and is fine for the
 *   gateway to start against.
 * - A store whose marker is missing, or whose id differs from rows the database
 *   holds, is a wrong mount: starting would serve errors and — worse — let a
 *   retention sweep delete rows whose files sit on the real volume.
 */
export async function assertArtifactStorageReady(role: 'gateway' | 'worker'): Promise<void> {
  const cfg = await resolveStorageConfig();
  if (!cfg.fsDir) {
    return;
  }
  const root = cfg.fsDir;
  const marker = await readFsStoreMarker(root);
  const stored = await prisma.workflowArtifact.count({ where: { backend: 'fs' } });
  if (!marker) {
    if (stored > 0) {
      throw new Error(
        `${stored} artifact(s) are stored in the filesystem store, but ${root} has no ${FS_STORE_MARKER}. ARTIFACT_FS_DIR must point at the directory those artifacts are in.`
      );
    }
    if (role === 'gateway') {
      return;
    }
    await ensureFsStore(root);
  } else if (stored > 0) {
    const foreign = await prisma.workflowArtifact.count({
      where: {
        backend: 'fs',
        OR: [{ fsStoreId: null }, { fsStoreId: { not: marker.storeId } }],
      },
    });
    if (foreign > 0) {
      throw new Error(
        `${foreign} artifact(s) belong to a different filesystem store than the one mounted at ${root} (${marker.storeId}). Refusing to start: this mount is not the store the database expects.`
      );
    }
  }
  if (role === 'worker') {
    await probeFsStore(root);
  }
}

/** Convenience: fetch artifact body as a UTF-8 string. */
export async function getArtifactText(id: string): Promise<string> {
  const { body } = await getArtifact(id);
  return body.toString('utf8');
}
