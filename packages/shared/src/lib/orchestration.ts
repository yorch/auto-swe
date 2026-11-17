import { z } from 'zod';
import { BUDGET_TIERS } from '../types/workflow.js';
import { AGENT_REF_RE, AGENT_RUN_DELIVERIES, type AgentRunDelivery } from './agentRun.js';
import { isSafeGitBranchName } from './gitRef.js';
import {
  hasUnsafeChars,
  isWellFormedScope,
  PATH_SCOPE_MAX_LENGTH,
  PATH_SCOPES_MAX,
  type ParsedScope,
  type ParseScopeResult,
  parsePathScope,
  stripUnsafeChars,
} from './pathScope.js';

export {
  PATH_SCOPE_MAX_LENGTH,
  PATH_SCOPES_MAX,
  type ParsedScope,
  type ParseScopeResult,
  parsePathScope,
};

/**
 * Orchestrated agent runs: the contracts the gateway, worker and web share.
 *
 * Pure, zod-only and isolate-safe. An orchestration is a durable conversation in which an
 * `orchestrator` agent records intents and fixed code validates and applies them. Everything the
 * model can say crosses into code through the schemas below, and everything a child says crosses
 * back through `fenceChildResult`.
 */

// ── Identity and workflow constants ──────────────────────────────────────────

export const ORCHESTRATION_WORKFLOW_ID_PREFIX = 'orch-';

/** Temporal workflow id of an orchestration. */
export function orchestrationWorkflowId(id: string): string {
  return `${ORCHESTRATION_WORKFLOW_ID_PREFIX}${id}`;
}

/**
 * Signal names. Workflow code cannot import this module at runtime (V8 isolate), so the worker
 * duplicates the strings; a test on the worker side pins the two together. Keep the names stable.
 */
export const ORCHESTRATION_SIGNALS = {
  approvalResolved: 'approvalResolved',
  attachResolved: 'attachResolved',
  cancel: 'cancel',
  childFinished: 'childFinished',
  userMessage: 'userMessage',
} as const;

/** How long a quiet orchestration with no running child waits before it completes. */
export const ORCHESTRATION_IDLE_TIMEOUT = '30 minutes';
/** Turns after which the workflow continues as new. */
export const ORCHESTRATION_MAX_TURNS_PER_EXECUTION = 50;

// ── Enumerations (mirrors of the Prisma enums, plus the child status vocabulary) ──

export const ORCHESTRATION_STATUSES = [
  'ACTIVE',
  'WAITING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
] as const;
export type OrchestrationStatusValue = (typeof ORCHESTRATION_STATUSES)[number];

export const CHILD_ROLES = ['READER', 'WRITER'] as const;
export type ChildRole = (typeof CHILD_ROLES)[number];

export const MESSAGE_ROLES = ['USER', 'ORCHESTRATOR', 'SYSTEM'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MESSAGE_KINDS = [
  'TEXT',
  'ATTACH_REQUEST',
  'APPROVAL_REQUEST',
  'CHILD_RESULT',
  'NOTICE',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'] as const;
export type ApprovalStatusValue = (typeof APPROVAL_STATUSES)[number];

/** Held by a CHECK constraint on `orchestration_children.status`, not a Prisma enum. */
export const CHILD_STATUSES = ['STARTING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type ChildStatus = (typeof CHILD_STATUSES)[number];

/** The run budget tiers, not a copy: an orchestration's tier is a work request's tier. */
export const ORCHESTRATION_BUDGET_TIERS = BUDGET_TIERS;
/** The agent-run deliveries, not a copy: the attach card's default is one of them. */
export const ORCHESTRATION_DELIVERY_DEFAULTS = AGENT_RUN_DELIVERIES;

/** Coded refusals of a spawn, attach or message. The worker turns each into a SYSTEM message. */
export const ORCHESTRATION_REFUSAL_CODES = [
  'CHILD_NOT_ALLOWED',
  'CHILD_LIMIT',
  'SCOPE_OVERLAP',
  'PUSH_PERMISSION_REQUIRED',
  'REPO_REQUIRED',
  'CONNECTION_NOT_IN_SET',
  'AGENT_RUN_CONCURRENCY_EXCEEDED',
  'ORCHESTRATION_NOT_ACTIVE',
  'ROLE_RULE_VIOLATED',
  'REPO_ALREADY_ATTACHED',
] as const;
export type OrchestrationRefusalCode = (typeof ORCHESTRATION_REFUSAL_CODES)[number];

export function isOrchestrationRefusalCode(value: unknown): value is OrchestrationRefusalCode {
  return (
    typeof value === 'string' && (ORCHESTRATION_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

// ── Path scopes (spec section 4.3) ───────────────────────────────────────────

/** Lock files by name; the generic basename rule below catches the ones not listed. */
const LOCK_FILE_RE =
  /(^|\/)(yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock|deno\.lock|flake\.lock|Podfile\.lock|packages\.lock\.json|gradle\.lockfile)$/i;
/** Any basename that looks like a lock file. Fails closed: a false positive only asks for the owner flag. */
const GENERIC_LOCK_BASENAME_RE = /\.lock$|\.lockfile$|-lock\.|\.lock\./i;
const ROOT_PACKAGE_JSON_RE = /^package\.json$/i;
const BARREL_RE = /(^|\/)(index\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs)|__init__\.py|mod\.rs)$/i;

function isLockLikeBasename(path: string): boolean {
  return GENERIC_LOCK_BASENAME_RE.test(baseOf(path));
}

/** Files several writers would otherwise collide on. A scope naming one needs the owner flag. */
export const SHARED_FILE_PATTERNS: readonly RegExp[] = [
  LOCK_FILE_RE,
  GENERIC_LOCK_BASENAME_RE,
  ROOT_PACKAGE_JSON_RE,
  BARREL_RE,
];

export function isSharedFilePath(path: string): boolean {
  return (
    LOCK_FILE_RE.test(path) ||
    isLockLikeBasename(path) ||
    ROOT_PACKAGE_JSON_RE.test(path) ||
    BARREL_RE.test(path)
  );
}

/** Names a `dir/*.ext` glob could match that are shared files, for the shared-file rule. */
const SHARED_PROBE_NAMES = [
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'deno.lock',
  'flake.lock',
  'Podfile.lock',
  'packages.lock.json',
  'gradle.lockfile',
  'package.json',
  'index.ts',
  'index.tsx',
  'index.mts',
  'index.cts',
  'index.d.ts',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  '__init__.py',
  'mod.rs',
];

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** `*` or `*.a.b` against a bare file name. */
function globNameMatches(globBase: string, name: string): boolean {
  const suffix = globBase.slice(1);
  return name.length > suffix.length && name.endsWith(suffix);
}

function scopeNamesSharedFile(scope: ParsedScope): boolean {
  if (scope.kind === 'file') {
    return isSharedFilePath(scope.path);
  }
  if (scope.kind === 'dir') {
    const dir = dirOf(scope.path);
    const glob = baseOf(scope.path);
    return SHARED_PROBE_NAMES.some((name) => {
      if (!globNameMatches(glob, name)) {
        return false;
      }
      return isSharedFilePath(dir === '' ? name : `${dir}/${name}`);
    });
  }
  // A tree covers whatever lives under it; two writers' trees are kept apart by the overlap rule.
  return false;
}

export type ValidateScopesResult =
  | { ok: true; scopes: ParsedScope[] }
  | { ok: false; errors: string[] };

/** A bounded, non-throwing description of a rejected entry. */
function describeRejected(raw: unknown): string {
  return typeof raw === 'string' ? JSON.stringify(raw.slice(0, 80)) : `a ${typeof raw} entry`;
}

/**
 * Parse, deduplicate and check a writer's scopes. A writer needs at least one, so an empty list is
 * refused (a caller that wants "no restriction" must not call this). `isOwnerOfSharedFiles` is the
 * caller's verdict that no other writer of the orchestration holds a shared file (lock file, root
 * `package.json`, barrel); without it a scope that names one is refused. A scope inside a subtree
 * is not refused here, because the overlap rule already keeps sibling writers' subtrees apart.
 * Never throws.
 */
export function validatePathScopes(
  scopes: readonly string[],
  opts: { isOwnerOfSharedFiles?: boolean } = {}
): ValidateScopesResult {
  try {
    if (!Array.isArray(scopes)) {
      return { errors: ['scopes must be a list'], ok: false };
    }
    if (scopes.length === 0) {
      return { errors: ['at least one path scope is required'], ok: false };
    }
    if (scopes.length > PATH_SCOPES_MAX) {
      return { errors: [`at most ${PATH_SCOPES_MAX} path scopes are allowed`], ok: false };
    }
    const errors: string[] = [];
    const seen = new Set<string>();
    const out: ParsedScope[] = [];
    for (const raw of scopes) {
      const parsed = parsePathScope(raw);
      if (!parsed.ok) {
        errors.push(`${describeRejected(raw)}: ${parsed.reason}`);
        continue;
      }
      if (!opts.isOwnerOfSharedFiles && scopeNamesSharedFile(parsed.scope)) {
        errors.push(
          `${JSON.stringify(parsed.scope.path)}: names a shared file (lock file, root package.json or index barrel) that only one writer may own`
        );
        continue;
      }
      const key = `${parsed.scope.kind}:${parsed.scope.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(parsed.scope);
    }
    return errors.length > 0 ? { errors, ok: false } : { ok: true, scopes: out };
  } catch {
    return { errors: ['scopes could not be read'], ok: false };
  }
}

function isPrefixDir(prefix: string, dir: string): boolean {
  return prefix === dir || dir.startsWith(`${prefix}/`);
}

function suffixOfGlobBase(globBase: string): string {
  return globBase.slice(1);
}

/**
 * Whether two scopes could cover the same path. Conservative: anything it cannot classify
 * overlaps, and a malformed scope (not what `parsePathScope` would produce) is unclassifiable.
 * Comparison folds case, so two writers cannot be separated by `Src/` and `src/` on a
 * case-insensitive checkout (`pathInScopes` stays case-sensitive, which is the stricter side).
 */
export function pathScopesOverlap(a: ParsedScope, b: ParsedScope): boolean {
  if (!isWellFormedScope(a) || !isWellFormedScope(b)) {
    return true;
  }
  const pa = a.path.toLowerCase();
  const pb = b.path.toLowerCase();

  if (a.kind === 'tree' && b.kind === 'tree') {
    return isPrefixDir(pa, pb) || isPrefixDir(pb, pa);
  }
  if (a.kind === 'tree') {
    return isPrefixDir(pa, dirOf(pb));
  }
  if (b.kind === 'tree') {
    return isPrefixDir(pb, dirOf(pa));
  }

  // Neither is a tree: both reach only the files directly in one directory.
  if (dirOf(pa) !== dirOf(pb)) {
    return false;
  }
  const ba = baseOf(pa);
  const bb = baseOf(pb);
  if (a.kind === 'file' && b.kind === 'file') {
    return ba === bb;
  }
  if (a.kind === 'file') {
    return globNameMatches(bb, ba);
  }
  if (b.kind === 'file') {
    return globNameMatches(ba, bb);
  }
  const sa = suffixOfGlobBase(ba);
  const sb = suffixOfGlobBase(bb);
  return sa.endsWith(sb) || sb.endsWith(sa);
}

/** Index of the first existing writer whose scopes overlap any candidate scope, else `null`. */
export function firstOverlap(
  existing: readonly (readonly ParsedScope[])[],
  candidate: readonly ParsedScope[]
): number | null {
  for (let i = 0; i < existing.length; i++) {
    const group = existing[i] ?? [];
    for (const have of group) {
      for (const want of candidate) {
        if (pathScopesOverlap(have, want)) {
          return i;
        }
      }
    }
  }
  return null;
}

/**
 * Normalise a changed-file path for a scope check; `null` when it cannot be trusted. A path that
 * is not already in NFC form is untrusted: comparing it as written could separate it from a scope
 * that names the same file, so it is out of scope rather than silently folded.
 */
function normaliseChangedPath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  if (hasUnsafeChars(path) || path.includes('\\') || path.normalize('NFC') !== path) {
    return null;
  }
  if (path.startsWith('/')) {
    return null;
  }
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') {
      return null;
    }
    if (seg === '' || seg === '.') {
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0 || path.endsWith('/')) {
    return null;
  }
  return out.join('/');
}

/**
 * Whether a changed path falls inside one of the scopes. Case-sensitive; fails closed: an
 * untrusted path, an empty list, or any malformed scope in the list is "not in scope".
 */
export function pathInScopes(path: string, scopes: readonly ParsedScope[]): boolean {
  const p = normaliseChangedPath(path);
  if (p === null || !Array.isArray(scopes) || !scopes.every(isWellFormedScope)) {
    return false;
  }
  for (const scope of scopes) {
    if (scope.kind === 'tree') {
      if (p.startsWith(`${scope.path}/`)) {
        return true;
      }
    } else if (scope.kind === 'file') {
      if (p === scope.path) {
        return true;
      }
    } else if (scope.kind === 'dir') {
      if (dirOf(p) === dirOf(scope.path) && globNameMatches(baseOf(scope.path), baseOf(p))) {
        return true;
      }
    }
  }
  return false;
}

// ── MCP read-only classification (spec section 7) ────────────────────────────

/**
 * True only when the tool declares `readOnlyHint: true` as an own data property. Missing,
 * inherited, accessor-backed or malformed is a write, and so is anything that throws when read
 * (a hostile Proxy).
 */
export function isReadOnlyMcpTool(annotations: unknown): boolean {
  try {
    if (typeof annotations !== 'object' || annotations === null || Array.isArray(annotations)) {
      return false;
    }
    if (!Object.hasOwn(annotations, 'readOnlyHint')) {
      return false;
    }
    const desc = Object.getOwnPropertyDescriptor(annotations, 'readOnlyHint');
    return desc !== undefined && 'value' in desc && desc.value === true;
  } catch {
    return false;
  }
}

// ── Intents ──────────────────────────────────────────────────────────────────

const agentRefSchema = z.string().min(1).max(130).regex(AGENT_REF_RE);

/** `key` of a `key` or `key@version` ref, lower-cased and trimmed. */
function agentRefBase(ref: string): string {
  return (ref.split('@')[0] ?? '').trim().toLowerCase();
}

/** The orchestrator may not spawn itself, however the ref is spelled. */
function isOrchestratorRef(ref: string): boolean {
  return agentRefBase(ref) === 'orchestrator';
}

/** Free text a model or a person wrote: no NUL (Postgres rejects it), bidi or other control characters. */
function isCleanText(value: string): boolean {
  return !hasUnsafeChars(value, true);
}

/** First occurrence of each value, compared by `key`. */
function dedupeBy<T>(values: readonly T[], key: (v: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of values) {
    const k = key(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/**
 * What a launch asks for. `teamId` and `repoId` may both be given: `teamId` is the team the
 * orchestrator's own spend bills, `repoId` the repository attached from the start. The schema
 * cannot know their relation, so the gateway enforces that `teamId` is the repository's owning team
 * (or a team the caller may bill) before it accepts the launch.
 */
export const OrchestrationLaunchSchema = z
  .object({
    allowlist: z
      .array(agentRefSchema)
      .min(1)
      .max(20)
      .refine((refs) => !refs.some(isOrchestratorRef), {
        message: 'the orchestrator cannot be on its own allowlist',
      })
      .transform((refs) => dedupeBy(refs, (r) => r)),
    budgetTier: z.enum(ORCHESTRATION_BUDGET_TIERS).default('STANDARD'),
    connectionIds: z
      .array(z.string().uuid())
      .max(10)
      .transform((ids) => dedupeBy(ids, (id) => id.toLowerCase()))
      .optional(),
    deliveryDefault: z.enum(ORCHESTRATION_DELIVERY_DEFAULTS).default('none'),
    repoId: z.string().uuid().optional(),
    task: z.string().trim().min(1).max(20_000).refine(isCleanText, {
      message: 'task contains a control character',
    }),
    teamId: z.string().uuid().optional(),
  })
  .refine((v) => v.teamId !== undefined || v.repoId !== undefined, {
    message: 'teamId or repoId is required',
    path: ['teamId'],
  });
export type OrchestrationLaunch = z.infer<typeof OrchestrationLaunchSchema>;

export const SpawnIntentSchema = z
  .object({
    agent: agentRefSchema.refine((ref) => !isOrchestratorRef(ref), {
      message: 'the orchestrator cannot spawn itself',
    }),
    deliver: z.enum(AGENT_RUN_DELIVERIES).optional(),
    label: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((v) => !hasUnsafeChars(v), { message: 'label contains a control character' }),
    maxSteps: z.number().int().min(1).max(500).optional(),
    pathScopes: z.array(z.string().max(PATH_SCOPE_MAX_LENGTH)).max(PATH_SCOPES_MAX).optional(),
    role: z.enum(['reader', 'writer']),
    task: z.string().trim().min(1).max(20_000).refine(isCleanText, {
      message: 'task contains a control character',
    }),
  })
  .superRefine((v, ctx) => {
    const scopes = v.pathScopes ?? [];
    if (v.role === 'reader') {
      if (v.deliver !== undefined && v.deliver !== 'none') {
        ctx.addIssue({
          code: 'custom',
          message: 'a reader delivers nothing',
          path: ['deliver'],
        });
      }
      if (scopes.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'a reader has no path scopes',
          path: ['pathScopes'],
        });
      }
      return;
    }
    if (v.deliver !== 'branch' && v.deliver !== 'draft_pr') {
      ctx.addIssue({
        code: 'custom',
        message: 'a writer needs deliver "branch" or "draft_pr"',
        path: ['deliver'],
      });
    }
    if (scopes.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a writer needs at least one path scope',
        path: ['pathScopes'],
      });
    }
    const parsedScopes: ParsedScope[] = [];
    scopes.forEach((raw, i) => {
      const parsed = parsePathScope(raw);
      if (!parsed.ok) {
        ctx.addIssue({ code: 'custom', message: parsed.reason, path: ['pathScopes', i] });
      } else {
        parsedScopes.push(parsed.scope);
      }
    });
    // Identical scopes are tolerated (`validatePathScopes` merges them, and the schema stays free
    // of transforms because it is also the tool's JSON schema); different scopes of one writer must
    // be disjoint, so a single intent cannot hide a contradiction from the cross-writer overlap rule.
    const distinct = dedupeBy(parsedScopes, (s) => `${s.kind}:${s.path}`);
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        if (pathScopesOverlap(distinct[i] as ParsedScope, distinct[j] as ParsedScope)) {
          ctx.addIssue({
            code: 'custom',
            message: "a writer's own path scopes overlap each other",
            path: ['pathScopes'],
          });
          return;
        }
      }
    }
  });
export type SpawnIntent = z.infer<typeof SpawnIntentSchema>;
export type SpawnDelivery = AgentRunDelivery;

export const MessageIntentSchema = z.object({
  childId: z.string().min(1).max(64),
  message: z.string().min(1).max(4000),
});
export type MessageIntent = z.infer<typeof MessageIntentSchema>;

export const CancelIntentSchema = z.object({ childId: z.string().min(1).max(64) });
export type CancelIntent = z.infer<typeof CancelIntentSchema>;

export const RequestRepoIntentSchema = z.object({
  candidate: z.string().uuid().optional(),
  reason: z.string().min(1).max(500),
});
export type RequestRepoIntent = z.infer<typeof RequestRepoIntentSchema>;

// ── Child result (spec section 4.2) ──────────────────────────────────────────

export const CHILD_RESULT_MAX_CHARS = 20_000;

/** An `https:` URL with no credentials and no control or whitespace characters. */
function isHttpsUrl(value: string): boolean {
  if (hasUnsafeChars(value) || /\s/u.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

export const ChildResultSchema = z.object({
  branch: z
    .string()
    .max(300)
    .refine((v) => !hasUnsafeChars(v) && isSafeGitBranchName(v), {
      message: 'is not a valid branch name',
    })
    .optional(),
  costUsd: z.number().min(0),
  filesChanged: z
    .array(
      z.object({
        added: z.number().int().min(0),
        path: z.string().max(1000),
        removed: z.number().int().min(0),
      })
    )
    .max(500)
    .default([]),
  gate: z.enum(['passed', 'no_changes', 'not_applicable', 'failed']).optional(),
  prUrl: z.string().max(1000).refine(isHttpsUrl, { message: 'must be an https URL' }).optional(),
  status: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']),
  stoppedReason: z.string().max(200).optional(),
  summary: z.string().max(CHILD_RESULT_MAX_CHARS),
});
export type ChildResult = z.infer<typeof ChildResultSchema>;

/** `String(value)` that cannot throw (a hostile `toString`, a Symbol). */
function safeString(value: unknown): string {
  try {
    return String(value ?? '');
  } catch {
    return '';
  }
}

/**
 * Entity for the characters that could open or close markup. EVERY `<`, `>` and `&` is replaced,
 * so no lookalike spelling of a tag survives: the fence cannot be closed or reopened by any text,
 * because the text contains no markup at all.
 */
const MARKUP_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeAttr(value: unknown): string {
  let out = '';
  let count = 0;
  for (const ch of stripUnsafeChars(safeString(value), false)) {
    if (count++ >= 120) {
      break;
    }
    out += MARKUP_ENTITIES[ch] ?? (ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch);
  }
  return out;
}

/**
 * The only form in which a child's words reach the orchestrator: a quoted block. Every `<`, `>`
 * and `&` in the text and the attributes is escaped to an entity, so nothing inside can close or
 * reopen the block (lookalike spellings included), at the price that the model reads angle
 * brackets as entities. Control, invisible and bidi characters are dropped. Truncation happens
 * after escaping, whole characters and whole entities at a time. Never throws.
 */
export function fenceChildResult(input: {
  childId: string;
  agent: string;
  status: string;
  text: string;
}): string {
  const source = stripUnsafeChars(safeString(input?.text).replace(/\r\n?/g, '\n'), true);
  let text = '';
  let truncated = false;
  for (const ch of source) {
    const piece = MARKUP_ENTITIES[ch] ?? ch;
    if (text.length + piece.length > CHILD_RESULT_MAX_CHARS) {
      truncated = true;
      break;
    }
    text += piece;
  }
  if (truncated) {
    text += '\n[truncated]';
  }
  return `<child-result id="${escapeAttr(input?.childId)}" agent="${escapeAttr(input?.agent)}" status="${escapeAttr(input?.status)}">\n${text}\n</child-result>`;
}
