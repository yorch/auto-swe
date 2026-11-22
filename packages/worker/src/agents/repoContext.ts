import path from 'node:path';
import type { Workspace } from '../activities/workspace.js';
import { WORKSPACE_DIR } from './harness/adapter.js';

/**
 * The repository's own instruction file, read into the system prompt of a
 * workspace run.
 *
 * One reader for every runtime that works in a container, so a run reads the
 * same file whatever loop drives it: `AGENTS.md`, else `CLAUDE.md`, at the
 * checkout's root. Nested files are not read — Pi has never read them, and a
 * runtime that did would run under instructions the other one never saw.
 *
 * It is read from **the base commit the workspace was created against**
 * (`Workspace.baseSha`, the fetched base-branch tip), not from the working tree,
 * for the reason the repository's declared tools are read from the base ref: the
 * instructions a run follows must not be something the agent, an earlier session
 * on the branch, or a pull-request author wrote. That also keeps a conflicted
 * working tree (the merge-conflict resolver) from putting conflict markers in the
 * prompt.
 *
 * It is read **once, when the workspace is created**, and carried on the
 * workspace: `createWorkspace` resolves it right after the base commit is fixed
 * and before any repository code runs (the setup steps come later), so neither a
 * setup step, a build script nor the agent has had a chance to touch the clone
 * when the text is taken. A read at prompt time would be reading a container
 * whose `.git` repository code can rewrite, with or without replace refs.
 *
 * The entry is read with git's plumbing, `--no-replace-objects`, by the object id
 * the tree listing named, and its mode is what separates a file from a symlink —
 * git stores a symlink as a blob holding the path it points at. A symlink is
 * followed inside the same commit, the way a person reading the repository would
 * follow it.
 */
export const REPO_CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** The most of a context file the prompt carries. */
export const MAX_REPO_CONTEXT_BYTES = 64 * 1024;

/** The heading the context file sits under, in every runtime's system prompt. */
export const REPO_CONTEXT_HEADING = '# Project Context';

/** The git modes a context file may have. Anything else is not a file this reads. */
const REGULAR_MODES = new Set(['100644', '100755']);

/** The mode of a symlink, whose content is the path it points at. */
const SYMLINK_MODE = '120000';

/** How many symlinks one lookup follows before giving up. */
const MAX_SYMLINK_HOPS = 3;

/** A commit id this will ask git to read: never empty, never an option. */
const BASE_SHA = /^[0-9a-f]{7,64}$/i;

export interface RepoContext {
  content: string;
  /** The absolute path the content came from, which a symlink may have moved. */
  path: string;
  /** The commit it was read at, abbreviated for the prompt. */
  commitSha: string;
}

/** One entry of the base commit, as the workspace reader reports it. */
export interface RepoEntry {
  content: string;
  mode: string;
}

/**
 * The context file's text as a prompt block, or '' when there is none. Callers
 * append it to a system prompt; it names the file and the commit, so a model can
 * tell where the instructions came from and that they are not live edits.
 */
export function repoContextBlock(context: RepoContext | null): string {
  if (!context) {
    return '';
  }
  return [
    REPO_CONTEXT_HEADING,
    '',
    'Project-specific instructions and guidelines:',
    '',
    `## ${context.path} (commit ${context.commitSha})`,
    '',
    context.content,
  ].join('\n');
}

/**
 * Whether `rel` — a path relative to the checkout — names a context file at the
 * checkout's root. Both runtimes refuse to write either name, and both decide
 * that by this one rule, so a change to the list moves both. It is deliberately
 * case-insensitive, and so deliberately slightly wider than the read: a
 * lower-case `agents.md` is not loaded, but nothing is gained by letting a
 * session rewrite it.
 */
export function isRepoContextFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  return REPO_CONTEXT_FILES.some((name) => lower === name.toLowerCase());
}

/** `content` cut to {@link MAX_REPO_CONTEXT_BYTES}, without splitting a UTF-8 character. */
export function capRepoContext(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length <= MAX_REPO_CONTEXT_BYTES) {
    return content;
  }
  const capped = bytes.subarray(0, MAX_REPO_CONTEXT_BYTES).toString('utf8');
  // A cut inside a multi-byte character decodes to U+FFFD; drop that one character
  // rather than hand the model a replacement glyph.
  return capped.endsWith('\uFFFD') ? capped.slice(0, -1) : capped;
}

/**
 * The path a symlink's stored target names, relative to the link's own directory,
 * or null when that target leaves the repository or is not a plain path.
 */
function symlinkTarget(from: string, stored: string): string | null {
  const target = stored.replace(/\n+$/, '');
  if (!target || target.includes('\n') || target.startsWith('/')) {
    return null;
  }
  const segments = target.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) {
    return null;
  }
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
  return path.posix.normalize(`${dir}${target}`);
}

/** The regular file at `rel`, following symlinks inside the same commit, or null. */
async function resolveEntry(
  read: (rel: string) => Promise<RepoEntry | null>,
  rel: string,
  hops = 0
): Promise<{ content: string; rel: string } | null> {
  const entry = await read(rel);
  if (!entry) {
    return null;
  }
  if (REGULAR_MODES.has(entry.mode)) {
    return { content: capRepoContext(entry.content), rel };
  }
  if (entry.mode !== SYMLINK_MODE || hops >= MAX_SYMLINK_HOPS) {
    return null;
  }
  const target = symlinkTarget(rel, entry.content);
  return target === null ? null : resolveEntry(read, target, hops + 1);
}

/**
 * The first of {@link REPO_CONTEXT_FILES} present at `baseSha`, read through
 * `read`.
 *
 * A read that fails throws, and does not quietly fall through to the next name:
 * if `AGENTS.md` is there and cannot be read, running the session under
 * `CLAUDE.md` instead — or under no instructions at all — is worse than failing
 * the step that was resolving them. The caller decides what a throw means; for
 * `createWorkspace` it fails the workspace, as an unreadable setup file does.
 */
export async function readRepoContext(
  baseSha: string,
  read: (rel: string) => Promise<RepoEntry | null>
): Promise<RepoContext | null> {
  if (!BASE_SHA.test(baseSha)) {
    return null;
  }
  const commitSha = baseSha.slice(0, 7);
  for (const name of REPO_CONTEXT_FILES) {
    const found = await resolveEntry(read, name);
    if (found) {
      return { commitSha, content: found.content, path: `${WORKSPACE_DIR}/${found.rel}` };
    }
  }
  return null;
}

/**
 * The repository's instructions for a workspace, as `createWorkspace` resolved them.
 *
 * Both loops call this, and it reads nothing: the file was read once when the workspace was
 * created, before any repository code ran (`activities/workspace.ts`), so every prompt built from
 * this workspace carries what the base commit said and cannot be moved by a setup step, a build
 * script or the agent itself.
 */
export function readWorkspaceRepoContext(
  workspace: Pick<Workspace, 'repoContext'>
): RepoContext | null {
  return workspace.repoContext ?? null;
}
