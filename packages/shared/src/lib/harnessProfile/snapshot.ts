import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { ProfileManifest } from './manifest.js';
import { collisionKey, MAX_PATH_BYTES, unsafeProfilePath } from './paths.js';
import { PROFILE_LIMITS, type ProfileFile } from './types.js';
import { computeContentHash } from './validate.js';

const PackedSchema = z.array(
  z.strictObject({
    content: z.string(),
    mode: z.enum(['100644', '100755']),
    path: z.string(),
  })
);

/** Fixed JSON text around one entry: `{"content":"","mode":"100644","path":""},`. */
const ENTRY_OVERHEAD = 48;

/**
 * Largest decompressed snapshot JSON that can be produced from files within {@link PROFILE_LIMITS}:
 * base64 of the content, plus per entry the fixed text and a path of at most MAX_PATH_BYTES whose
 * every byte may be escaped (`"` becomes `\"`). Any snapshot that packs at approval unpacks.
 */
const MAX_JSON_BYTES =
  Math.ceil((PROFILE_LIMITS.maxTotalBytes * 4) / 3) +
  PROFILE_LIMITS.maxFiles * (ENTRY_OVERHEAD + 2 * MAX_PATH_BYTES) +
  1024;

/** The stored form of a snapshot: gzip of `[{ path, mode, content: base64 }]`, sorted by path. */
export function packFiles(files: readonly ProfileFile[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return gzipSync(
    JSON.stringify(
      sorted.map((f) => ({ content: f.bytes.toString('base64'), mode: f.mode, path: f.path }))
    )
  );
}

/**
 * Read a stored snapshot back. The decompressed size is bounded, every path is re-checked, and
 * the count, per-file and total sizes and case-insensitive path collisions are re-enforced, so a
 * corrupted or tampered row cannot write outside the directory it is materialised into.
 */
export function unpackFiles(blob: Uint8Array): ProfileFile[] {
  const json = gunzipSync(blob, { maxOutputLength: MAX_JSON_BYTES }).toString('utf8');
  const packed = PackedSchema.parse(JSON.parse(json));
  if (packed.length > PROFILE_LIMITS.maxFiles) {
    throw new Error('snapshot holds too many files');
  }
  const seen = new Set<string>();
  let total = 0;
  return packed.map((f) => {
    if (unsafeProfilePath(f.path) !== null) {
      throw new Error('snapshot holds an unsafe path');
    }
    const key = collisionKey(f.path);
    if (seen.has(key)) {
      throw new Error('snapshot holds a duplicate path');
    }
    seen.add(key);
    const bytes = Buffer.from(f.content, 'base64');
    total += bytes.length;
    if (bytes.length > PROFILE_LIMITS.maxFileBytes || total > PROFILE_LIMITS.maxTotalBytes) {
      throw new Error('snapshot exceeds the profile size limits');
    }
    return { bytes, mode: f.mode, path: f.path };
  });
}

/**
 * {@link unpackFiles}, then recompute the content hash over the files and the stored manifest and
 * refuse the snapshot unless it equals the hash the version was approved under. This is the
 * entry point for materialising a snapshot: a blob that was altered after approval (a file
 * changed, added or removed, a mode flipped) does not reproduce the approved identity.
 */
export function unpackAndVerify(
  blob: Uint8Array,
  manifest: ProfileManifest,
  expectedContentHash: string
): ProfileFile[] {
  const files = unpackFiles(blob);
  if (computeContentHash(files, manifest) !== expectedContentHash) {
    throw new Error('snapshot does not match its content hash');
  }
  return files;
}
