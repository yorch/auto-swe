import { z } from 'zod';
import { AGENT_REF_RE, AGENT_RUN_DELIVERIES, type AgentRunDelivery } from './agentRun.js';

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

export const ORCHESTRATION_BUDGET_TIERS = ['STANDARD', 'LARGE', 'EPIC'] as const;
export const ORCHESTRATION_DELIVERY_DEFAULTS = ['none', 'branch', 'draft_pr'] as const;

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

export const PATH_SCOPE_MAX_LENGTH = 200;
export const PATH_SCOPES_MAX = 20;

/**
 * A parsed scope. `path` is the directory for `tree` (`src/lib/**` has path `src/lib`), the whole
 * pattern for `dir` (`src/*.ts`), and the file path for `file`.
 */
export type ParsedScope = { kind: 'tree' | 'dir' | 'file'; path: string };

export type ParseScopeResult = { ok: true; scope: ParsedScope } | { ok: false; reason: string };

/**
 * C0/C1 controls, soft hyphen, bidi controls and zero-width characters: none belongs in a
 * repository path or an attribute a reviewer is meant to read. Done by code point rather than a
 * regular expression so the source carries no literal control characters.
 */
function isUnsafeCodePoint(c: number, keepWhitespace: boolean): boolean {
  if (keepWhitespace && (c === 0x0a || c === 0x09)) {
    return false;
  }
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xad ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f) ||
    c === 0xfeff
  );
}

function hasUnsafeChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeCodePoint(value.charCodeAt(i), false)) {
      return true;
    }
  }
  return false;
}

function stripUnsafeChars(value: string, keepWhitespace: boolean): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (!isUnsafeCodePoint(value.charCodeAt(i), keepWhitespace)) {
      out += value[i];
    }
  }
  return out;
}

const GLOB_CHARS_RE = /[*?[\]{}]/;
const DIR_GLOB_FILE_RE = /^\*(\.[A-Za-z0-9_-]+)*$/;

function nfc(value: string): string {
  return value.normalize('NFC');
}

export function parsePathScope(raw: string): ParseScopeResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'scope must be a string' };
  }
  if (raw.length === 0) {
    return { ok: false, reason: 'scope is empty' };
  }
  if (raw.length > PATH_SCOPE_MAX_LENGTH) {
    return { ok: false, reason: `scope is longer than ${PATH_SCOPE_MAX_LENGTH} characters` };
  }
  if (hasUnsafeChars(raw)) {
    return { ok: false, reason: 'scope contains a control character' };
  }
  if (raw !== raw.trim()) {
    return { ok: false, reason: 'scope has leading or trailing whitespace' };
  }
  if (raw.includes('\\')) {
    return { ok: false, reason: 'scope contains a backslash' };
  }
  if (raw.startsWith('/')) {
    return { ok: false, reason: 'scope is an absolute path' };
  }
  const scope = nfc(raw);
  const segments = scope.split('/');
  if (segments.some((s) => s === '')) {
    return { ok: false, reason: 'scope has an empty segment or a trailing slash' };
  }
  if (segments.some((s) => s === '..')) {
    return { ok: false, reason: 'scope contains ..' };
  }
  if (segments.some((s) => s === '.')) {
    return { ok: false, reason: 'scope contains a . segment' };
  }
  if (/^[A-Za-z]:$/.test(segments[0] ?? '')) {
    return { ok: false, reason: 'scope looks like a drive path' };
  }

  const last = segments[segments.length - 1] as string;
  const parents = segments.slice(0, -1);
  if (parents.some((s) => GLOB_CHARS_RE.test(s))) {
    return { ok: false, reason: 'a wildcard is only allowed in the last segment' };
  }

  if (last === '**') {
    if (parents.length === 0) {
      return { ok: false, reason: '** needs a directory in front of it' };
    }
    return { ok: true, scope: { kind: 'tree', path: parents.join('/') } };
  }
  if (last.includes('**')) {
    return { ok: false, reason: '** is only allowed as a whole last segment' };
  }
  if (GLOB_CHARS_RE.test(last)) {
    if (!DIR_GLOB_FILE_RE.test(last)) {
      return { ok: false, reason: 'the only glob form is * or *.ext in the last segment' };
    }
    return { ok: true, scope: { kind: 'dir', path: scope } };
  }
  return { ok: true, scope: { kind: 'file', path: scope } };
}

const LOCK_FILE_RE =
  /(^|\/)(yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;
const ROOT_PACKAGE_JSON_RE = /^package\.json$/;
const BARREL_RE = /(^|\/)index\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Files several writers would otherwise collide on. A scope naming one needs the owner flag. */
export const SHARED_FILE_PATTERNS: readonly RegExp[] = [
  LOCK_FILE_RE,
  ROOT_PACKAGE_JSON_RE,
  BARREL_RE,
];

export function isSharedFilePath(path: string): boolean {
  return SHARED_FILE_PATTERNS.some((re) => re.test(path));
}

/** Names a `dir/*.ext` glob could match that are shared files, for the shared-file rule. */
const SHARED_PROBE_NAMES = [
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'package.json',
  'index.ts',
  'index.tsx',
  'index.mts',
  'index.cts',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
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

/**
 * Parse, deduplicate and check a writer's scopes. `isOwnerOfSharedFiles` is the caller's verdict
 * that no other writer of the orchestration holds a shared file (lock file, root `package.json`,
 * barrel); without it a scope that names one is refused. A scope inside a subtree is not refused
 * here, because the overlap rule already keeps sibling writers' subtrees apart.
 */
export function validatePathScopes(
  scopes: readonly string[],
  opts: { isOwnerOfSharedFiles?: boolean } = {}
): ValidateScopesResult {
  if (!Array.isArray(scopes)) {
    return { errors: ['scopes must be a list'], ok: false };
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
      errors.push(
        `${JSON.stringify(typeof raw === 'string' ? raw.slice(0, 80) : raw)}: ${parsed.reason}`
      );
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
}

function isPrefixDir(prefix: string, dir: string): boolean {
  return prefix === dir || dir.startsWith(`${prefix}/`);
}

function suffixOfGlobBase(globBase: string): string {
  return globBase.slice(1);
}

/**
 * Whether two scopes could cover the same path. Conservative: anything it cannot classify
 * overlaps. Comparison folds case, so two writers cannot be separated by `Src/` and `src/` on a
 * case-insensitive checkout (`pathInScopes` stays case-sensitive, which is the stricter side).
 */
export function pathScopesOverlap(a: ParsedScope, b: ParsedScope): boolean {
  const kinds = ['tree', 'dir', 'file'];
  if (
    !a ||
    !b ||
    !kinds.includes(a.kind) ||
    !kinds.includes(b.kind) ||
    typeof a.path !== 'string' ||
    typeof b.path !== 'string'
  ) {
    return true;
  }
  const pa = nfc(a.path).toLowerCase();
  const pb = nfc(b.path).toLowerCase();

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

/** Normalise a changed-file path for a scope check; `null` when it cannot be trusted. */
function normaliseChangedPath(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  if (hasUnsafeChars(path) || path.includes('\\')) {
    return null;
  }
  if (path.startsWith('/')) {
    return null;
  }
  const out: string[] = [];
  for (const seg of nfc(path).split('/')) {
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

/** Whether a changed path falls inside one of the scopes. Case-sensitive; fails closed. */
export function pathInScopes(path: string, scopes: readonly ParsedScope[]): boolean {
  const p = normaliseChangedPath(path);
  if (p === null) {
    return false;
  }
  for (const scope of scopes) {
    if (!scope || typeof scope.path !== 'string') {
      continue;
    }
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

/** True only when the tool declares `readOnlyHint: true`. Missing or malformed is a write. */
export function isReadOnlyMcpTool(annotations: unknown): boolean {
  if (typeof annotations !== 'object' || annotations === null || Array.isArray(annotations)) {
    return false;
  }
  return (annotations as { readOnlyHint?: unknown }).readOnlyHint === true;
}

// ── Intents ──────────────────────────────────────────────────────────────────

const agentRefSchema = z.string().min(1).max(130).regex(AGENT_REF_RE);

export const OrchestrationLaunchSchema = z
  .object({
    allowlist: z.array(agentRefSchema).min(1).max(20),
    budgetTier: z.enum(ORCHESTRATION_BUDGET_TIERS).default('STANDARD'),
    connectionIds: z.array(z.string().uuid()).max(10).optional(),
    deliveryDefault: z.enum(ORCHESTRATION_DELIVERY_DEFAULTS).default('none'),
    repoId: z.string().uuid().optional(),
    task: z.string().trim().min(1).max(20_000),
    teamId: z.string().uuid().optional(),
  })
  .refine((v) => v.teamId !== undefined || v.repoId !== undefined, {
    message: 'teamId or repoId is required',
    path: ['teamId'],
  });
export type OrchestrationLaunch = z.infer<typeof OrchestrationLaunchSchema>;

export const SpawnIntentSchema = z
  .object({
    agent: agentRefSchema,
    deliver: z.enum(AGENT_RUN_DELIVERIES).optional(),
    label: z.string().trim().min(1).max(80),
    maxSteps: z.number().int().min(1).max(500).optional(),
    pathScopes: z.array(z.string().max(PATH_SCOPE_MAX_LENGTH)).max(PATH_SCOPES_MAX).optional(),
    role: z.enum(['reader', 'writer']),
    task: z.string().min(1).max(20_000),
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
    scopes.forEach((raw, i) => {
      const parsed = parsePathScope(raw);
      if (!parsed.ok) {
        ctx.addIssue({ code: 'custom', message: parsed.reason, path: ['pathScopes', i] });
      }
    });
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

export const ChildResultSchema = z.object({
  branch: z.string().max(300).optional(),
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
  prUrl: z.string().max(1000).optional(),
  status: z.enum(['COMPLETED', 'FAILED', 'CANCELLED']),
  stoppedReason: z.string().max(200).optional(),
  summary: z.string().max(CHILD_RESULT_MAX_CHARS),
});
export type ChildResult = z.infer<typeof ChildResultSchema>;

function escapeAttr(value: string): string {
  return stripUnsafeChars(value, false)
    .slice(0, 120)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The only form in which a child's words reach the orchestrator: a quoted block. Anything that
 * could close or reopen the block is neutralised, so the text cannot step outside it.
 */
export function fenceChildResult(input: {
  childId: string;
  agent: string;
  status: string;
  text: string;
}): string {
  let text = stripUnsafeChars(String(input.text ?? '').replace(/\r\n?/g, '\n'), true)
    // Any `<` that begins (or nearly begins) a child-result tag, closing or opening.
    .replace(/<(?=\s*\/?\s*child[-_ ]?result)/gi, '&lt;');
  if (text.length > CHILD_RESULT_MAX_CHARS) {
    text = text.slice(0, CHILD_RESULT_MAX_CHARS);
    const tail = text.charCodeAt(text.length - 1);
    if (tail >= 0xd800 && tail <= 0xdbff) {
      text = text.slice(0, -1);
    }
    text += '\n[truncated]';
  }
  return `<child-result id="${escapeAttr(input.childId)}" agent="${escapeAttr(input.agent)}" status="${escapeAttr(input.status)}">\n${text}\n</child-result>`;
}
