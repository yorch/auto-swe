/**
 * The filesystem artifact store: a mounted directory holding run evidence,
 * transcripts and step outputs when the deployment has no object store.
 *
 * The store is a directory the operator provisions and mounts into **every**
 * process that reads artifacts — the worker writes, and the gateway serves
 * evidence and transcripts from it. It is single-host by design: a shared
 * volume across hosts has to provide rename and fsync semantics this module
 * cannot verify (`docs/deployment.md` §5c).
 *
 * Layout, all inside `ARTIFACT_FS_DIR`:
 *
 *   .auto-swe-artifacts.json   the store identity, written on first use
 *   .tmp/<artifactId>.part     a write in flight; renamed into place when done
 *   <runId|global>/<kind>/<id> the artifact
 *
 * The marker is what makes a wrong mount fail closed. Every row records the
 * store id it was written to; a read or a delete against a different (or
 * absent) store throws instead of treating the missing file as "already
 * deleted" and dropping the row that is the only record of it.
 */

import crypto from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

export const FS_STORE_MARKER = '.auto-swe-artifacts.json';
export const FS_TEMP_DIR = '.tmp';
const MARKER_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path component we are willing to build: no dot segments, no separators. */
const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Enough for a day of abandoned writes; a larger backlog is a disk problem. */
const MAX_TEMP_ENTRIES = 5_000;

/**
 * Turn a permission failure into an actionable message: on Linux a bind-mounted
 * directory is created root-owned, and this image runs as uid 1000.
 */
function storeAccessError(error: unknown, root: string): Error {
  const code = codeOf(error);
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(
      `artifact store ${path.resolve(root)} is not writable by this process (${code}); a bind-mounted directory must be chowned to the uid the service runs as (1000 in the shipped images)`
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface FsStoreMarker {
  storeId: string;
  version: number;
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Reject a relative artifact path that could leave the store or nest oddly. */
export function normaliseArtifactPath(relativePath: string): string {
  const segments = relativePath.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid artifact path: ${relativePath}`);
  }
  return segments.join('/');
}

/** The store-relative path of one artifact. `runId` is a UUID or omitted. */
export function artifactRelativePath(input: {
  id: string;
  kind: string;
  runId?: string | null;
}): string {
  if (!UUID_RE.test(input.id)) {
    throw new Error(`invalid artifact id: ${input.id}`);
  }
  if (!KIND_RE.test(input.kind)) {
    throw new Error(`invalid artifact kind: ${input.kind}`);
  }
  if (input.runId && !UUID_RE.test(input.runId)) {
    throw new Error(`invalid artifact run id: ${input.runId}`);
  }
  return `${input.runId ?? 'global'}/${input.kind}/${input.id}`;
}

/** Resolve a store-relative path inside the store, or throw. */
export function resolveInsideStore(root: string, relativePath: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, normaliseArtifactPath(relativePath));
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`artifact path escapes the store: ${relativePath}`);
  }
  return target;
}

/**
 * Refuse a path whose existing parents are symlinks: `mkdir -p` and `rename`
 * would follow one out of the store. The store root is operator-provisioned and
 * not writable by anyone else; this is the check that keeps that true.
 */
async function assertRealParents(root: string, relativePath: string): Promise<void> {
  const segments = normaliseArtifactPath(relativePath).split('/').slice(0, -1);
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: unknown) => {
      if (codeOf(error) === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`artifact store path ${current} is a symlink; refusing to use it`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`artifact store path ${current} is not a directory`);
    }
  }
}

/** fsync a directory so a rename into it survives a power loss. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch {
    // Some filesystems (and macOS) refuse fsync on a directory; the rename is
    // still atomic there. The data file itself is synced before the rename.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readFsStoreMarker(root: string): Promise<FsStoreMarker | null> {
  const markerPath = path.join(path.resolve(root), FS_STORE_MARKER);
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FsStoreMarker>;
    if (
      parsed.version !== MARKER_VERSION ||
      typeof parsed.storeId !== 'string' ||
      !UUID_RE.test(parsed.storeId)
    ) {
      throw new Error('unexpected marker contents');
    }
    return { storeId: parsed.storeId, version: MARKER_VERSION };
  } catch {
    throw new Error(
      `artifact store marker ${markerPath} is unreadable; refusing to use this directory as the store`
    );
  }
}

/**
 * Create the store directory and its identity marker on first use. A race
 * between two workers is settled by `O_EXCL`: the loser reads the winner's
 * marker, so one directory can never hold two identities.
 */
export async function ensureFsStore(root: string): Promise<FsStoreMarker> {
  const base = path.resolve(root);
  try {
    await fs.mkdir(base, { mode: 0o700, recursive: true });
  } catch (error) {
    throw storeAccessError(error, base);
  }
  const stat = await fs.stat(base);
  if (!stat.isDirectory()) {
    throw new Error(`ARTIFACT_FS_DIR is not a directory: ${base}`);
  }
  const existing = await readFsStoreMarker(base);
  if (existing) {
    return existing;
  }
  const marker: FsStoreMarker = { storeId: crypto.randomUUID(), version: MARKER_VERSION };
  const markerPath = path.join(base, FS_STORE_MARKER);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(markerPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(marker)}\n`);
    await handle.sync();
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') {
      throw error;
    }
    const raced = await readFsStoreMarker(base);
    if (raced) {
      return raced;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await syncDirectory(base);
  return marker;
}

/** Throw unless the directory at `root` is the store a row was written to. */
export async function assertFsStore(
  root: string,
  expectedStoreId: string | null
): Promise<FsStoreMarker> {
  const marker = await readFsStoreMarker(root);
  if (!marker) {
    throw new Error(
      `no artifact store marker in ${path.resolve(root)}; ARTIFACT_FS_DIR does not point at the store this artifact was written to`
    );
  }
  if (expectedStoreId && marker.storeId !== expectedStoreId) {
    throw new Error(
      `artifact store at ${path.resolve(root)} is a different store (${marker.storeId}) than the one this artifact belongs to (${expectedStoreId})`
    );
  }
  return marker;
}

/**
 * Write one artifact. The temporary file is created exclusively and synced, the
 * rename publishes it atomically, and the target directory is synced before the
 * caller marks its row ready — so a row is never ready for bytes that a crash
 * could still drop.
 */
export async function writeFsArtifact(input: {
  body: Buffer;
  root: string;
  relativePath: string;
}): Promise<void> {
  const root = path.resolve(input.root);
  const relativePath = normaliseArtifactPath(input.relativePath);
  const target = resolveInsideStore(root, relativePath);
  const tempDir = resolveInsideStore(root, FS_TEMP_DIR);

  // Check the parents that already exist before creating anything: a symlinked
  // parent would otherwise let `mkdir -p` build the tree outside the store.
  await assertRealParents(root, relativePath);
  await fs.mkdir(path.dirname(target), { mode: 0o700, recursive: true });
  await fs.mkdir(tempDir, { mode: 0o700, recursive: true });
  await assertRealParents(root, relativePath);

  const temporary = path.join(tempDir, `${path.basename(target)}.part`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(input.body);
    await handle.sync();
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectory(path.dirname(target));
  await syncDirectory(tempDir);
}

/**
 * Open one artifact for streaming. The file handle is opened without following a
 * symlink and its actual size is returned so a response can set an accurate
 * Content-Length; the stream closes the handle when it ends or is destroyed.
 */
export async function openFsArtifactStream(input: {
  root: string;
  relativePath: string;
}): Promise<{ sizeBytes: number; stream: Readable }> {
  await assertRealParents(input.root, input.relativePath);
  const target = resolveInsideStore(input.root, input.relativePath);
  const handle = await fs.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    return { sizeBytes: stat.size, stream: handle.createReadStream() };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Remove one artifact and its in-flight temporary, if any. A missing file is
 * fine **only after** the store identity matched: the caller verifies that
 * first, so a wrong mount cannot turn "file is on the real volume" into a
 * deleted row.
 */
export async function deleteFsArtifact(input: {
  root: string;
  relativePath: string;
}): Promise<void> {
  await assertRealParents(input.root, input.relativePath);
  const target = resolveInsideStore(input.root, input.relativePath);
  const temporary = path.join(
    resolveInsideStore(input.root, FS_TEMP_DIR),
    `${path.basename(target)}.part`
  );
  await fs.rm(target, { force: true });
  await fs.rm(temporary, { force: true });
  await syncDirectory(path.dirname(target));
}

/**
 * Delete abandoned temporary files older than `olderThanMs`. A writer killed
 * between creating its temporary and renaming it leaves one, and the pending
 * sweep only reaches rows; this is the sweep for the files no row names.
 * Bounded so one bad directory cannot stall the daily job.
 */
export async function sweepArtifactTempFiles(
  root: string,
  olderThanMs: number,
  now: number = Date.now()
): Promise<number> {
  const tempDir = resolveInsideStore(root, FS_TEMP_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(tempDir);
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return 0;
    }
    throw error;
  }
  let removed = 0;
  for (const entry of entries.slice(0, MAX_TEMP_ENTRIES)) {
    const file = path.join(tempDir, entry);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || now - stat.mtimeMs < olderThanMs) {
        continue;
      }
      await fs.rm(file, { force: true });
      removed += 1;
    } catch {
      // A file that vanished between readdir and lstat is already gone.
    }
  }
  return removed;
}

/**
 * Prove the worker can actually write into the store: create a probe file
 * exclusively, sync it, remove it. A directory that exists but is read-only,
 * owned by another uid, or on a full disk fails the worker's boot instead of
 * its first artifact write.
 */
export async function probeFsStore(root: string): Promise<void> {
  const marker = await ensureFsStore(root);
  if (!marker.storeId) {
    throw new Error(`artifact store at ${path.resolve(root)} has no identity`);
  }
  const tempDir = resolveInsideStore(root, FS_TEMP_DIR);
  try {
    await fs.mkdir(tempDir, { mode: 0o700, recursive: true });
  } catch (error) {
    throw storeAccessError(error, root);
  }
  const probe = path.join(tempDir, `probe-${crypto.randomUUID()}.part`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(probe, 'wx', 0o600);
    await handle.writeFile('ok');
    await handle.sync();
  } catch (error) {
    throw storeAccessError(error, root);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(probe, { force: true }).catch(() => undefined);
  }
}
