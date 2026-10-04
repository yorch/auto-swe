import { MAX_SKILL_PROMPT_TEXT_LENGTH } from '../regexSafety.js';
import { safeDisplayPath } from './display.js';
import { SkillSourceError } from './errors.js';
import {
  apiGet,
  defaultDeps,
  resolveAccess,
  type SkillSourceDeps,
  type SourceAccess,
} from './github.js';
import { parseSkillMd } from './parse.js';

export { safeDisplayPath } from './display.js';
export {
  SKILL_SOURCE_ERRORS,
  SkillSourceError,
  type SkillSourceErrorCode,
  safeSourceErrorMessage,
} from './errors.js';
export { hostPermitted, MAX_API_REQUESTS, type SkillSourceDeps } from './github.js';
export { MAX_DESCRIPTION_LENGTH, parseSkillMd } from './parse.js';

export const MAX_SKILLS_PER_SOURCE = 100;
export const MAX_SOURCE_BYTES = 2_000_000;
/** Reference text beside a skill: files per skill and bytes per file. */
export const MAX_REFERENCE_FILES = 50;
export const MAX_REFERENCE_FILE_BYTES = 100_000;
const BLOB_CONCURRENCY = 6;

export type ScriptMode = 'TEXT_ONLY' | 'REJECT';

/** A source location as an admin gives it. */
export interface SourceLocation {
  host: string;
  owner: string;
  repo: string;
  /** Subdirectory holding the skills; empty for the repository root. */
  path: string;
  ref: string;
}

export type SkippedReason =
  | 'not-text'
  | 'too-large'
  | 'too-many'
  | 'symlink'
  | 'submodule'
  | 'unreadable';

export interface SkippedFile {
  path: string;
  reason: SkippedReason;
}

export interface ReferenceFile {
  path: string;
  content: string;
}

/** One skill folder found in a source. `errors` non-empty means it cannot be installed. */
export interface SourceSkill {
  /** Repo-relative folder of the SKILL.md ('' for the repo root). */
  folder: string;
  name: string | null;
  description: string | null;
  promptText: string;
  referenceFiles: ReferenceFile[];
  skippedFiles: SkippedFile[];
  /** Frontmatter keys the import does not read (already safe to display). */
  ignoredKeys: string[];
  errors: string[];
}

export interface FetchedSource {
  /** The commit the content was read at. */
  sha: string;
  skills: SourceSkill[];
}

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Normalise and validate a location; throws INVALID_SOURCE. Lowercases host/owner/repo. */
export function normaliseLocation(input: SourceLocation): SourceLocation {
  const host = input.host.trim().toLowerCase();
  const owner = input.owner.trim().toLowerCase();
  const repo = input.repo.trim().toLowerCase();
  const path = normaliseRelPath(input.path);
  const ref = input.ref.trim();
  if (
    path === null ||
    !OWNER_REPO_RE.test(owner) ||
    !OWNER_REPO_RE.test(repo) ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..' ||
    !validRef(ref)
  ) {
    throw new SkillSourceError('INVALID_SOURCE');
  }
  return { host, owner, path, ref, repo };
}

function validRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 255 &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
    !/[\u0000- \u007f~^:?*[\\]/.test(ref) &&
    !ref.includes('..') &&
    !ref.split('/').includes('.') &&
    !ref.startsWith('-') &&
    !ref.startsWith('/') &&
    !ref.endsWith('/') &&
    !ref.includes('//') &&
    !ref.endsWith('.lock')
  );
}

/**
 * A repo-relative path with no `.`/`..`/empty segments, no backslash and no
 * leading slash; '' for the root. Null when it is anything else.
 */
function normaliseRelPath(raw: string): string | null {
  const p = raw.trim().replace(/\/+$/, '');
  if (p === '') {
    return '';
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (p.startsWith('/') || p.includes('\\') || /[\u0000-\u001f\u007f]/.test(p)) {
    return null;
  }
  const segments = p.split('/');
  return segments.some((s) => s === '' || s === '.' || s === '..') ? null : p;
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
const repoApi = (loc: SourceLocation) =>
  `/repos/${encodeURIComponent(loc.owner)}/${encodeURIComponent(loc.repo)}`;

/** Resolve the ref to a commit sha. */
async function resolveSha(access: SourceAccess, loc: SourceLocation): Promise<string> {
  const body = (await apiGet(access, `${repoApi(loc)}/commits/${enc(loc.ref)}`)) as {
    sha?: unknown;
  } | null;
  if (typeof body?.sha !== 'string' || !SHA_RE.test(body.sha)) {
    throw new SkillSourceError('BAD_RESPONSE');
  }
  return body.sha;
}

/** Resolve a location's ref to the commit it names now. */
export async function resolveSourceSha(
  input: SourceLocation,
  deps: SkillSourceDeps = defaultDeps
): Promise<string> {
  const loc = normaliseLocation(input);
  return resolveSha(await resolveAccess(loc.host, deps), loc);
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
}

async function listTree(access: SourceAccess, loc: SourceLocation, sha: string) {
  const body = (await apiGet(access, `${repoApi(loc)}/git/trees/${sha}?recursive=1`)) as {
    tree?: unknown;
    truncated?: unknown;
  } | null;
  if (!body || !Array.isArray(body.tree)) {
    throw new SkillSourceError('BAD_RESPONSE');
  }
  // A truncated tree silently omits files: importing from it would install a
  // partial skill that looks complete.
  if (body.truncated === true) {
    throw new SkillSourceError('TREE_TRUNCATED');
  }
  const entries: TreeEntry[] = [];
  for (const raw of body.tree as Array<Record<string, unknown>>) {
    const { path, mode, type, sha: entrySha, size } = raw;
    if (
      typeof path !== 'string' ||
      typeof mode !== 'string' ||
      typeof type !== 'string' ||
      typeof entrySha !== 'string'
    ) {
      throw new SkillSourceError('BAD_RESPONSE');
    }
    // Git forbids these in a path; one here means the listing is not to be trusted.
    if (unsafeTreePath(path)) {
      throw new SkillSourceError('BAD_PATH');
    }
    entries.push({
      mode,
      path,
      sha: entrySha,
      size: typeof size === 'number' ? size : 0,
      type,
    });
  }
  return entries;
}

/** `..`/`.`/empty segments, an absolute path or a backslash: never in a real git listing. */
function unsafeTreePath(p: string): boolean {
  return (
    p === '' ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..')
  );
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
// A name with control characters is never stored as reference text, whatever its extension.
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const isText = (p: string) => /\.(md|txt)$/i.test(p) && !/[\u0000-\u001f\u007f]/.test(p);
const isSkillMd = (p: string) => basename(p) === 'SKILL.md';
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

interface Plan {
  skill: SourceSkill;
  skillMd: TreeEntry;
  refs: Array<{ entry: TreeEntry; rel: string }>;
}

/** Which skill folder owns `path`: the deepest SKILL.md folder that is an ancestor. */
function ownerFolder(path: string, folders: readonly string[]): string | null {
  let best: string | null = null;
  for (const f of folders) {
    const inside = f === '' || path.startsWith(`${f}/`);
    if (inside && (best === null || f.length > best.length)) {
      best = f;
    }
  }
  return best;
}

/** Group a tree's entries under `loc.path` into skill folders and decide what to fetch. */
function plan(entries: TreeEntry[], loc: SourceLocation, mode: ScriptMode): Plan[] {
  const prefix = loc.path === '' ? '' : `${loc.path}/`;
  const inScope = entries.filter((e) => e.path.startsWith(prefix));
  const skillMds = inScope.filter((e) => e.type === 'blob' && isSkillMd(e.path) && isRegular(e));
  const folders = skillMds.map((e) => dirname(e.path));
  const plans = new Map<string, Plan>();
  for (const md of skillMds) {
    const folder = dirname(md.path);
    plans.set(folder, {
      refs: [],
      skill: {
        description: null,
        errors: [],
        folder,
        ignoredKeys: [],
        name: null,
        promptText: '',
        referenceFiles: [],
        skippedFiles: [],
      },
      skillMd: md,
    });
  }
  for (const e of inScope) {
    if (e.type === 'tree') {
      continue;
    }
    const folder = ownerFolder(e.path, folders);
    const owner = folder === null ? undefined : plans.get(folder);
    if (folder === null || !owner || (isSkillMd(e.path) && dirname(e.path) === folder)) {
      continue;
    }
    const rel = folder === '' ? e.path : e.path.slice(folder.length + 1);
    if (e.mode === '120000') {
      owner.skill.skippedFiles.push({ path: safeDisplayPath(rel), reason: 'symlink' });
    } else if (e.mode === '160000' || e.type === 'commit') {
      owner.skill.skippedFiles.push({ path: safeDisplayPath(rel), reason: 'submodule' });
    } else if (e.type !== 'blob') {
    } else if (!isText(e.path)) {
      owner.skill.skippedFiles.push({ path: safeDisplayPath(rel), reason: 'not-text' });
    } else if (e.size > MAX_REFERENCE_FILE_BYTES) {
      owner.skill.skippedFiles.push({ path: safeDisplayPath(rel), reason: 'too-large' });
    } else if (owner.refs.length >= MAX_REFERENCE_FILES) {
      owner.skill.skippedFiles.push({ path: safeDisplayPath(rel), reason: 'too-many' });
    } else {
      owner.refs.push({ entry: e, rel });
    }
  }
  for (const p of plans.values()) {
    if (isUnprintable(p.skill.folder)) {
      // The folder is stored as the skill's source path and shown to an admin.
      p.skill.errors.push('the skill folder name contains control characters');
    }
    const scripts = p.skill.skippedFiles.filter((f) => f.reason === 'not-text');
    if (mode === 'REJECT' && scripts.length > 0) {
      const shown = scripts.slice(0, 5).map((f) => safeDisplayPath(f.path));
      const more = scripts.length > 5 ? ` and ${scripts.length - 5} more` : '';
      p.skill.errors.push(
        `rejected: the folder holds files other than .md/.txt (${shown.join(', ')}${more})`
      );
      p.refs = [];
    }
  }
  return [...plans.values()].sort((a, b) => a.skill.folder.localeCompare(b.skill.folder));
}

/**
 * A source costs one request per `SKILL.md` and one per kept reference file,
 * beside the two for the ref and the tree. When that exceeds the request
 * budget, reference files are dropped (and listed as skipped) from the last
 * skills first: the skills themselves come before their companion text. Only
 * when the skills alone do not fit is the source refused.
 */
function fitRequestBudget(plans: Plan[], access: SourceAccess): void {
  const spendable = access.budget.limits.maxRequests - 2 - plans.length;
  if (spendable < 0) {
    throw new SkillSourceError('LIMIT_REQUESTS');
  }
  let left = spendable;
  for (const p of plans) {
    const keep = p.refs.slice(0, left);
    for (const dropped of p.refs.slice(keep.length)) {
      p.skill.skippedFiles.push({ path: safeDisplayPath(dropped.rel), reason: 'too-many' });
    }
    left -= keep.length;
    p.refs = keep;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const isUnprintable = (p: string) => /[\u0000-\u001f\u007f-\u009f]/.test(p);

const isRegular = (e: TreeEntry) => e.mode !== '120000' && e.mode !== '160000';

/** Fetch one blob by sha and decode it as UTF-8; null when it cannot be read as text. */
async function fetchText(
  access: SourceAccess,
  loc: SourceLocation,
  sha: string,
  maxBytes: number
): Promise<string | null> {
  if (!SHA_RE.test(sha)) {
    throw new SkillSourceError('BAD_RESPONSE');
  }
  const blob = (await apiGet(access, `${repoApi(loc)}/git/blobs/${sha}`)) as {
    content?: unknown;
    encoding?: unknown;
  } | null;
  if (typeof blob?.content !== 'string' || blob.encoding !== 'base64') {
    throw new SkillSourceError('BAD_RESPONSE');
  }
  const bytes = Buffer.from(blob.content, 'base64');
  if (bytes.length > maxBytes) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function mapLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, items.length) }, worker));
}

/**
 * Read the skills in a source at one commit.
 *
 * Resolves the ref to a commit, lists the whole tree at that commit (refusing a
 * truncated listing), finds every folder holding a `SKILL.md`, and fetches each
 * needed blob by its sha. Nothing is ever executed, and no archive is
 * downloaded: only the `SKILL.md` and the `.md`/`.txt` files beside it are read.
 * A bad skill is reported on that skill (`errors`) without failing the others;
 * a source-level problem (host, truncation, limits) throws a {@link SkillSourceError}.
 *
 * `expectSha`, when given, is the commit a preview showed: the ref must still
 * resolve to it, or the call fails with `SHA_MOVED` before reading any content.
 */
export async function fetchSkillSource(
  input: SourceLocation,
  opts: { scriptMode: ScriptMode; expectSha?: string },
  deps: SkillSourceDeps = defaultDeps
): Promise<FetchedSource> {
  const loc = normaliseLocation(input);
  const access = await resolveAccess(loc.host, deps);
  const sha = await resolveSha(access, loc);
  if (opts.expectSha !== undefined && opts.expectSha !== sha) {
    throw new SkillSourceError('SHA_MOVED');
  }
  const plans = plan(await listTree(access, loc, sha), loc, opts.scriptMode);
  if (plans.length === 0) {
    throw new SkillSourceError('NO_SKILLS');
  }
  if (plans.length > MAX_SKILLS_PER_SOURCE) {
    throw new SkillSourceError('LIMIT_SKILLS');
  }
  fitRequestBudget(plans, access);

  // The total is over what would be fetched, known from the listing's sizes
  // before a single blob is requested.
  const mdBudget = MAX_SKILL_PROMPT_TEXT_LENGTH * 4;
  let total = 0;
  for (const p of plans) {
    if (p.skillMd.size > mdBudget) {
      p.skill.errors.push(`SKILL.md exceeds ${MAX_SKILL_PROMPT_TEXT_LENGTH} characters`);
    } else if (p.skill.errors.length === 0) {
      total += p.skillMd.size + p.refs.reduce((n, r) => n + r.entry.size, 0);
    }
  }
  if (total > MAX_SOURCE_BYTES) {
    throw new SkillSourceError('LIMIT_BYTES');
  }

  await mapLimited(
    plans.filter((p) => p.skill.errors.length === 0),
    async (p) => {
      const text = await fetchText(access, loc, p.skillMd.sha, mdBudget);
      if (text === null) {
        p.skill.errors.push('SKILL.md is not valid UTF-8 text');
        return;
      }
      const parsed = parseSkillMd(text);
      if (!parsed.ok) {
        p.skill.errors.push(parsed.error);
        return;
      }
      p.skill.name = parsed.name;
      p.skill.description = parsed.description;
      p.skill.ignoredKeys = parsed.ignoredKeys;
      p.skill.promptText = parsed.promptText;
      for (const ref of p.refs) {
        const content = await fetchText(access, loc, ref.entry.sha, MAX_REFERENCE_FILE_BYTES);
        if (content === null) {
          p.skill.skippedFiles.push({ path: safeDisplayPath(ref.rel), reason: 'unreadable' });
        } else {
          p.skill.referenceFiles.push({ content, path: ref.rel });
        }
      }
    }
  );

  const seen = new Map<string, number>();
  for (const p of plans) {
    if (p.skill.name !== null) {
      seen.set(p.skill.name.toLowerCase(), (seen.get(p.skill.name.toLowerCase()) ?? 0) + 1);
    }
  }
  for (const p of plans) {
    if (p.skill.name !== null && (seen.get(p.skill.name.toLowerCase()) ?? 0) > 1) {
      p.skill.errors.push('another skill in this source has the same name');
    }
  }
  return { sha, skills: plans.map((p) => p.skill) };
}
