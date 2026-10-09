import { z } from 'zod';

/**
 * Longest branch name accepted as a run's base. Git itself allows more, but a
 * name this long is already well past anything a host shows, and every byte of
 * it lands in a shell command line, a Temporal payload and a PR body.
 */
export const MAX_BRANCH_NAME_LENGTH = 200;

/** Characters git refuses in a ref name, besides control characters and space. */
const FORBIDDEN_CHARS = new Set(['~', '^', ':', '?', '*', '[', '\\']);

/**
 * Whether `name` is a branch name a run may be based on: valid under
 * `git check-ref-format --branch`, and never readable as an option.
 *
 * The git rules, applied to the short name: no ASCII control character, space,
 * `~ ^ : ? * [ \`, no `..`, no `@{`, not `@` alone, no component that starts
 * with `.` or ends with `.lock`, no empty component (a leading, trailing or
 * doubled `/`), and no trailing `.`. On top of git's rules a leading `-` is
 * refused, so no git subcommand can read the name as an option.
 *
 * This does NOT make a name safe to splice into a shell command: git allows
 * `$ ( ) ; | & '` and backticks in a branch name, and so does this. Every
 * caller shell-quotes it (`shellQuote`); that quoting is the protection.
 */
export function isSafeGitBranchName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) {
    return false;
  }
  if (name.startsWith('-') || name === '@' || name === 'HEAD') {
    return false;
  }
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || FORBIDDEN_CHARS.has(ch)) {
      return false;
    }
  }
  if (name.includes('..') || name.includes('@{') || name.endsWith('.')) {
    return false;
  }
  return name
    .split('/')
    .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Zod form of {@link isSafeGitBranchName}, for request bodies and run payloads. */
export const BaseBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_NAME_LENGTH)
  .refine(isSafeGitBranchName, { message: 'is not a valid branch name' });

/**
 * Whether `branch` is one of the platform's own work branches: the prefix
 * itself or anything under `<prefix>/`. A run may not be based on one — those
 * branches belong to other runs, and a run based on its own work branch could
 * not cut that branch from it.
 */
export function isPlatformWorkBranch(branch: string, branchPrefix: string): boolean {
  return branch === branchPrefix || branch.startsWith(`${branchPrefix}/`);
}

/**
 * The base branch a launch asked for, read from a run payload's `baseBranch`.
 *
 * `undefined` when the payload names none (the run uses the repository's
 * default branch). A value that is present but not a safe branch name is an
 * error, never silently dropped: a caller that asked for `release/1.4` and got
 * `main` would open a fix against the wrong line of development.
 */
export function baseBranchFromPayload(
  payload: unknown
): { ok: true; baseBranch: string | undefined } | { ok: false; message: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { baseBranch: undefined, ok: true };
  }
  const raw = (payload as Record<string, unknown>).baseBranch;
  if (raw === undefined || raw === null || raw === '') {
    return { baseBranch: undefined, ok: true };
  }
  if (typeof raw !== 'string' || !isSafeGitBranchName(raw)) {
    return { message: 'baseBranch is not a valid branch name', ok: false };
  }
  return { baseBranch: raw, ok: true };
}
