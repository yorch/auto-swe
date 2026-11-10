import { createHash } from 'node:crypto';
import { safeDisplayPath } from '../skillSource/display.js';
import {
  defaultDeps,
  fetchBlobBytes,
  listTree,
  mapLimited,
  normaliseLocation,
  resolveAccess,
  resolveSha,
  SHA_RE,
  type SkillSourceDeps,
  SkillSourceError,
  type SourceAccess,
  type SourceLocation,
  type TreeEntry,
} from '../skillSource/index.js';
import { collisionKey, unsafeProfilePath } from './paths.js';
import { PROFILE_LIMITS, type ProfileFile, type ProfileFileMode } from './types.js';

/** One request for the ref, one for the tree, one per file. */
const FIXED_REQUESTS = 2;
const PROFILE_DEADLINE_MS = 120_000;
const MAX_PROBLEMS = 20;

export interface ProfileFolderRead {
  /** The exact commit the files were read at. */
  sha: string;
  /** Empty when `problems` is not. */
  files: ProfileFile[];
  /**
   * Why the folder cannot be a profile (symlink, submodule, unsafe path, limits). Fixed sentences
   * that name display-safe paths. Nothing is downloaded while there are any.
   */
  problems: string[];
}

/**
 * Read every file of one repository folder at an exact commit.
 *
 * Reuses the skill-source machinery end to end (host policy, SSRF guard, manual redirects, token
 * scoping, rate floor, fixed error strings). A profile folder needs one request per file, so the
 * request budget is the file limit plus the fixed two, unless `deps.limits` says otherwise (a
 * lower cap is honoured and fails with `LIMIT_REQUESTS` before any file is fetched).
 *
 * Symlinks, submodules, unsafe paths and over-limit folders are reported as `problems`, never
 * followed or skipped: a profile that silently lacks a file is not the profile that was reviewed.
 * `atSha` reads that exact commit and never resolves the ref; `expectSha` fails `SHA_MOVED` when
 * the ref no longer resolves to the commit a preview showed. `onlyPath` (a path relative to the
 * folder) downloads that one blob and no other, for reviewing a single file: the listing is still
 * checked in full, and `files` is empty when the folder holds no such file.
 */
export async function readProfileFolder(
  input: SourceLocation,
  opts: { atSha?: string; expectSha?: string; onlyPath?: string } = {},
  deps: SkillSourceDeps = defaultDeps
): Promise<ProfileFolderRead> {
  const loc = normaliseLocation(input);
  const access = await resolveAccess(loc.host, {
    ...deps,
    limits: {
      deadlineMs: PROFILE_DEADLINE_MS,
      maxRequests: PROFILE_LIMITS.maxFiles + FIXED_REQUESTS,
      ...deps.limits,
    },
  });
  if (opts.atSha !== undefined && !SHA_RE.test(opts.atSha)) {
    throw new SkillSourceError('INVALID_SOURCE');
  }
  const sha = opts.atSha ?? (await resolveSha(access, loc));
  if (opts.expectSha !== undefined && opts.expectSha !== sha) {
    throw new SkillSourceError('SHA_MOVED');
  }

  const prefix = loc.path === '' ? '' : `${loc.path}/`;
  const inFolder = (await listTree(access, loc, sha)).filter(
    (e) => e.type !== 'tree' && e.path.startsWith(prefix)
  );
  const { plan, problems } = planFolder(inFolder, prefix);
  if (problems.length > 0) {
    return { files: [], problems: problems.slice(0, MAX_PROBLEMS), sha };
  }
  if (plan.length + FIXED_REQUESTS > access.budget.limits.maxRequests) {
    throw new SkillSourceError('LIMIT_REQUESTS');
  }

  const files: ProfileFile[] = [];
  const wanted = opts.onlyPath === undefined ? plan : plan.filter((p) => p.rel === opts.onlyPath);
  // mapLimited keeps starting items after one fails; once one has, start no more downloads.
  let failed = false;
  await mapLimited(wanted, async ({ entry, mode, rel }) => {
    if (failed) {
      return;
    }
    try {
      files.push({ bytes: await downloadVerified(access, loc, entry), mode, path: rel });
    } catch (err) {
      failed = true;
      throw err;
    }
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, problems: [], sha };
}

async function downloadVerified(
  access: SourceAccess,
  loc: SourceLocation,
  entry: TreeEntry
): Promise<Buffer> {
  const bytes = await fetchBlobBytes(access, loc, entry.sha);
  // The listing said what this blob is; the content must be exactly that, or the host (or
  // something on the path to it) is not telling one story.
  if (bytes.length !== entry.size || gitObjectId(bytes, entry.sha.length) !== entry.sha) {
    throw new SkillSourceError('BAD_RESPONSE');
  }
  return bytes;
}

interface Planned {
  entry: TreeEntry;
  mode: ProfileFileMode;
  rel: string;
}

/** Decide, from the listing alone, whether the folder can be read and what to fetch. */
function planFolder(entries: TreeEntry[], prefix: string): { plan: Planned[]; problems: string[] } {
  const problems: string[] = [];
  const plan: Planned[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const rel = entry.path.slice(prefix.length);
    const shown = safeDisplayPath(rel);
    if (entry.mode === '120000') {
      problems.push(`symlink not allowed: ${shown}`);
    } else if (entry.mode === '160000' || entry.type === 'commit') {
      problems.push(`submodule not allowed: ${shown}`);
    } else if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      problems.push(`unsupported file type: ${shown}`);
    } else if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      // The listing's size bounds the download and the limits below; a nonsense one is not to be trusted.
      throw new SkillSourceError('BAD_RESPONSE');
    } else if (unsafeProfilePath(rel) !== null) {
      problems.push(`unsafe path ${shown}: ${unsafeProfilePath(rel)}`);
    } else if (seen.has(collisionKey(rel))) {
      problems.push(`duplicate path after normalisation: ${shown}`);
    } else if (entry.size > PROFILE_LIMITS.maxFileBytes) {
      problems.push(`${shown} exceeds ${PROFILE_LIMITS.maxFileBytes} bytes`);
    } else {
      seen.add(collisionKey(rel));
      total += entry.size;
      plan.push({ entry, mode: entry.mode, rel });
    }
  }
  if (plan.length + problems.length > PROFILE_LIMITS.maxFiles) {
    problems.push(`the folder holds more than ${PROFILE_LIMITS.maxFiles} files`);
  }
  if (total > PROFILE_LIMITS.maxTotalBytes) {
    problems.push(`the folder exceeds ${PROFILE_LIMITS.maxTotalBytes} bytes in total`);
  }
  if (entries.length === 0) {
    problems.push('the folder is empty or does not exist at that commit');
  }
  return { plan, problems };
}

/** The Git object id of a blob (`sha1`, or `sha256` for a 64-character id). */
function gitObjectId(bytes: Buffer, idLength: number): string {
  return createHash(idLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}
