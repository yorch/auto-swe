/**
 * Artifact store — keeps large step outputs (diffs, logs, scan reports) out of
 * the workflow context object so we stay under Temporal's 50MB history cap.
 *
 * Two backends:
 *   - "s3" : any S3-compatible object store — the bundled Garage container,
 *            AWS S3, R2, B2. Active when ARTIFACT_S3_BUCKET is set. Loads
 *            @aws-sdk/client-s3 lazily. Only PutObject and GetObject are used.
 *   - "pg" : Postgres BYTEA column on workflow_artifacts. Default for local dev
 *            so contributors need no object store running at all.
 *
 * The interpreter passes artifact IDs through the run context. Activities call
 * getArtifact(id) to materialize the payload on demand.
 */

import { prisma } from '@auto-swe/shared/db';
import { resolveStorageConfig } from '@auto-swe/shared/lib/systemConfig';

export type ArtifactBackend = 's3' | 'pg';

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

async function activeBackend(): Promise<ArtifactBackend> {
  const cfg = await resolveStorageConfig();
  return cfg.backend === 's3' ? 's3' : 'pg';
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
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
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
    } | null;
    if (!mod) {
      throw new Error(
        '@aws-sdk/client-s3 not installed but S3 storage backend is active. ' +
          'Run `yarn workspace @auto-swe/worker add @aws-sdk/client-s3`.'
      );
    }
    const { S3Client, PutObjectCommand, GetObjectCommand } = mod;
    const storageCfg = await resolveStorageConfig();
    if (!storageCfg.s3Bucket) {
      throw new Error(
        'S3 backend is active but s3Bucket is not configured. Set it at /admin/integrations → Storage.'
      );
    }
    const region = storageCfg.s3Region ?? 'us-east-1';
    const endpoint = storageCfg.s3Endpoint ?? undefined;
    const forcePathStyle = storageCfg.s3ForcePathStyle;
    const client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle } : {}),
    });
    const bucket = storageCfg.s3Bucket;
    return {
      async getObject(key) {
        const resp = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!resp.Body) {
          throw new Error(`artifact body missing for s3://${bucket}/${key}`);
        }
        const bytes = await resp.Body.transformToByteArray();
        // Copy into a fresh Buffer/ArrayBuffer to satisfy strict typing on
        // Node's evolving Buffer types (avoids the SharedArrayBuffer mismatch).
        return Buffer.from(new Uint8Array(bytes));
      },
      async putObject(key, body, contentType) {
        await client.send(
          new PutObjectCommand({ Body: body, Bucket: bucket, ContentType: contentType, Key: key })
        );
      },
    };
  })();
  return s3ClientPromise;
}

export async function putArtifact(input: PutArtifactInput): Promise<ArtifactRef> {
  const backend = await activeBackend();
  const contentType = input.contentType ?? 'application/octet-stream';
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;

  if (backend === 's3') {
    const storageCfg = await resolveStorageConfig();
    if (!storageCfg.s3Bucket) {
      throw new Error(
        'S3 backend is active but s3Bucket is not configured. Set it at /admin/integrations → Storage.'
      );
    }
    const bucket = storageCfg.s3Bucket;
    const prefix = storageCfg.s3Prefix ?? 'workflow-artifacts';
    const key = `${prefix}/${input.runId ?? 'global'}/${input.kind}/${crypto.randomUUID()}`;
    const client = await s3Client();
    await client.putObject(key, body, contentType);
    const row = await prisma.workflowArtifact.create({
      data: {
        backend: 's3',
        contentType,
        kind: input.kind,
        runId: input.runId,
        s3Bucket: bucket,
        s3Key: key,
        sizeBytes: body.byteLength,
      },
    });
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
    const body = await client.getObject(row.s3Key);
    return { body, ref };
  }
  if (!row.inlineBlob) {
    throw new Error(`artifact ${id} has backend=pg but no inlineBlob`);
  }
  return { body: Buffer.from(row.inlineBlob), ref };
}

/** Convenience: fetch artifact body as a UTF-8 string. */
export async function getArtifactText(id: string): Promise<string> {
  const { body } = await getArtifact(id);
  return body.toString('utf8');
}
