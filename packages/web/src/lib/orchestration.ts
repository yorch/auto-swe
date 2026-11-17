import {
  APPROVAL_STATUSES,
  type ChildStatus,
  ORCHESTRATION_REFUSAL_CODES,
  type OrchestrationRefusalCode,
  type OrchestrationStatusValue,
} from '@auto-swe/shared/lib/orchestration';
import {
  type ApprovalRequestPayload,
  ApprovalRequestPayloadSchema,
  type AttachRequestPayload,
  AttachRequestPayloadSchema,
  type ChildResultPayload,
  ChildResultPayloadSchema,
} from '@auto-swe/shared/lib/orchestrationApi';
import { ApiError } from '@/lib/api';
import { isRecord } from '@/lib/utils';

/** Orchestration statuses that still accept work and are worth polling. */
export function isOrchestrationLive(status: OrchestrationStatusValue | undefined): boolean {
  return status === 'ACTIVE' || status === 'WAITING';
}

/** Child statuses that have not finished. */
export function isChildRunning(status: ChildStatus): boolean {
  return status === 'STARTING' || status === 'RUNNING';
}

/**
 * Why the composer is off, or null while it is open. A COMPLETED orchestration is open: a
 * message restarts it. Cancelled and failed ones stay closed.
 */
export function finishedReason(status: OrchestrationStatusValue): string | null {
  switch (status) {
    case 'CANCELLED':
      return 'This orchestration was cancelled. Start a new one to keep working.';
    case 'FAILED':
      return 'This orchestration failed. Start a new one to keep working.';
    default:
      return null;
  }
}

/** True when a message sent now starts the orchestration again. */
export function restartsOnMessage(status: OrchestrationStatusValue): boolean {
  return status === 'COMPLETED';
}

export const RESTART_NOTE = 'Sending a message restarts this orchestration.';

/** How an already-decided race is recognised: the item was resolved before this click landed. */
export const ALREADY_DECIDED_CODES = ['APPROVAL_NOT_PENDING', 'NO_PENDING_ATTACH'] as const;

export function isAlreadyDecided(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    (ALREADY_DECIDED_CODES as readonly (string | null)[]).includes(err.code)
  );
}

/**
 * The plain-language wording of every refusal code the orchestration routes answer with. One
 * table: a code added to the shared list without an entry here fails the type check.
 */
export const REFUSAL_MESSAGES: Record<OrchestrationRefusalCode, string> = {
  AGENT_RUN_CONCURRENCY_EXCEEDED:
    'Too many agent runs are in flight for this team. Try again when one finishes.',
  CHILD_LIMIT: 'This orchestration has reached its limit on agents. Start a new one to continue.',
  CHILD_NOT_ALLOWED: 'That agent is not on this orchestration’s allowlist.',
  CONNECTION_NOT_IN_SET: 'That agent needs an MCP connection that was not chosen at launch.',
  ORCHESTRATION_NOT_ACTIVE: 'This orchestration is no longer running.',
  PUSH_PERMISSION_REQUIRED:
    'Writing to this repository needs GitHub push permission, which you do not have.',
  REPO_ALREADY_ATTACHED: 'A repository is already attached to this orchestration.',
  REPO_REQUIRED: 'That needs a repository. Attach one first.',
  ROLE_RULE_VIOLATED: 'That agent’s role does not allow this action.',
  SCOPE_OVERLAP: 'Two writing agents would change the same paths. Narrow one of them.',
};

export function isRefusalCode(value: unknown): value is OrchestrationRefusalCode {
  return (
    typeof value === 'string' && (ORCHESTRATION_REFUSAL_CODES as readonly string[]).includes(value)
  );
}

/** What to show for a failed orchestration request: our wording for a known code, else the gateway's. */
export function describeOrchestrationError(err: unknown): string {
  if (err instanceof ApiError && isRefusalCode(err.code)) {
    return REFUSAL_MESSAGES[err.code];
  }
  if (err instanceof ApiError && err.code === 'ORCHESTRATION_DISABLED') {
    return 'Orchestrations are turned off. An administrator can enable them in Platform settings.';
  }
  return err instanceof Error && err.message ? err.message : 'The request failed.';
}

/** True when the text carries a control character, which no link target may. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * A link target from untrusted data: an `https:` URL with no credentials and no whitespace or
 * control characters (the same rule the gateway applies to a child's `prUrl`). Anything else is
 * shown as text.
 */
export function httpsUrl(value: string | null | undefined): string | null {
  if (!value || hasControlChars(value) || /\s/u.test(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? value : null;
  } catch {
    return null;
  }
}

/** A read of a string field out of an untrusted payload. */
export function payloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A transcript payload read with the shared schema; null when it does not fit (tolerated). */
export function parseAttachPayload(
  payload: Record<string, unknown> | null
): AttachRequestPayload | null {
  const parsed = AttachRequestPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseApprovalPayload(
  payload: Record<string, unknown> | null
): ApprovalRequestPayload | null {
  const parsed = ApprovalRequestPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseChildResultPayload(
  payload: Record<string, unknown> | null
): ChildResultPayload | null {
  const parsed = ChildResultPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export type ApprovalOutcome = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

/** A status string narrowed to the known approval statuses. */
export function asApprovalStatus(value: unknown): ApprovalOutcome | null {
  return typeof value === 'string' && (APPROVAL_STATUSES as readonly string[]).includes(value)
    ? (value as ApprovalOutcome)
    : null;
}

export const APPROVAL_OUTCOME_LABELS: Record<ApprovalOutcome, string> = {
  APPROVED: 'Approved',
  DENIED: 'Denied',
  EXPIRED: 'Expired',
  PENDING: 'Waiting for approval',
};

/** Plain-language names for a delivery default. */
export const DELIVERY_LABELS: Record<OrchestrateDelivery, string> = {
  branch: 'Push a branch for each change',
  draft_pr: 'Open a draft pull request for each change',
  none: 'Show results only; nothing is pushed',
};

export function deliveryLabel(value: unknown): string | null {
  return value === 'none' || value === 'branch' || value === 'draft_pr'
    ? DELIVERY_LABELS[value]
    : null;
}

/** Milliseconds a child ran (or has run so far). */
export function elapsedMs(createdAt: string, finishedAt: string | null, now: number): number {
  const end = finishedAt ? Date.parse(finishedAt) : now;
  return Math.max(0, end - Date.parse(createdAt));
}

/** `m:ss` / `h:mm:ss` countdown to `expiresAt`; null once it has passed. */
export function countdown(expiresAt: string, now: number): string | null {
  const left = Math.ceil((Date.parse(expiresAt) - now) / 1000);
  if (!Number.isFinite(left) || left <= 0) {
    return null;
  }
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── Launch form ──────────────────────────────────────────────────────────────

export const ORCHESTRATE_MAX_TASK_CHARS = 20_000;
export const ORCHESTRATE_MAX_ALLOWLIST = 20;
export const ORCHESTRATE_MAX_CONNECTIONS = 10;

export type OrchestrateBudgetTier = 'STANDARD' | 'LARGE' | 'EPIC';
export type OrchestrateDelivery = 'none' | 'branch' | 'draft_pr';

export const BUDGET_TIER_OPTIONS: { label: string; value: OrchestrateBudgetTier }[] = [
  { label: 'Standard', value: 'STANDARD' },
  { label: 'Large', value: 'LARGE' },
  { label: 'Epic', value: 'EPIC' },
];

export const DELIVERY_DEFAULT_OPTIONS: { label: string; value: OrchestrateDelivery }[] = [
  { label: 'Show me the results only', value: 'none' },
  { label: 'Push a branch for each change', value: 'branch' },
  { label: 'Open a draft pull request for each change', value: 'draft_pr' },
];

export interface OrchestrateFormValues {
  allowlist: string[];
  budgetTier: OrchestrateBudgetTier;
  connectionIds: string[];
  deliveryDefault: OrchestrateDelivery;
  repoId: string;
  task: string;
  teamId: string;
}

export type OrchestrateFormErrors = Partial<
  Record<'allowlist' | 'connectionIds' | 'task' | 'teamId', string>
>;

/** Client-side validation. A convenience: the gateway re-checks everything. */
export function validateOrchestrateForm(v: OrchestrateFormValues): OrchestrateFormErrors {
  const errors: OrchestrateFormErrors = {};
  if (v.task.trim() === '') {
    errors.task = 'Tell the orchestrator what to do';
  } else if (v.task.length > ORCHESTRATE_MAX_TASK_CHARS) {
    errors.task = `The task can be at most ${ORCHESTRATE_MAX_TASK_CHARS.toLocaleString('en-US')} characters`;
  }
  if (!v.repoId && !v.teamId) {
    errors.teamId = 'Choose a team, or a repository whose team the work runs under';
  }
  if (v.allowlist.length === 0) {
    errors.allowlist = 'Choose at least one agent the orchestrator may start';
  } else if (v.allowlist.length > ORCHESTRATE_MAX_ALLOWLIST) {
    errors.allowlist = `Choose at most ${ORCHESTRATE_MAX_ALLOWLIST} agents`;
  }
  if (v.connectionIds.length > ORCHESTRATE_MAX_CONNECTIONS) {
    errors.connectionIds = `Choose at most ${ORCHESTRATE_MAX_CONNECTIONS} connections`;
  }
  return errors;
}

/** The body of `POST /api/v1/orchestrations`. A team is sent only when there is no repository. */
export function buildOrchestrateBody(v: OrchestrateFormValues) {
  return {
    allowlist: v.allowlist,
    budgetTier: v.budgetTier,
    ...(v.connectionIds.length > 0 ? { connectionIds: v.connectionIds } : {}),
    deliveryDefault: v.repoId ? v.deliveryDefault : 'none',
    ...(v.repoId ? { repoId: v.repoId } : { teamId: v.teamId }),
    task: v.task.trim(),
  };
}

/** The parts of a child's result the dashboard shows, every field a plain string or number. */
export interface DisplayResult {
  branch: string | null;
  filesChanged: { added: number; path: string; removed: number }[];
  prUrl: string | null;
  status: string;
  summary: string;
}

/**
 * A child result read out of an untrusted payload, field by field. The strict schema refuses a
 * result whose link is not https, and that must not hide the agent's summary: here an
 * unacceptable value is shown as text and never linked.
 */
export function coerceResult(raw: unknown): DisplayResult | null {
  if (!isRecord(raw) || typeof raw.summary !== 'string') {
    return null;
  }
  const files = Array.isArray(raw.filesChanged) ? raw.filesChanged : [];
  return {
    branch: typeof raw.branch === 'string' ? raw.branch : null,
    filesChanged: files.flatMap((f) =>
      isRecord(f) && typeof f.path === 'string'
        ? [
            {
              added: typeof f.added === 'number' ? f.added : 0,
              path: f.path,
              removed: typeof f.removed === 'number' ? f.removed : 0,
            },
          ]
        : []
    ),
    prUrl: typeof raw.prUrl === 'string' ? raw.prUrl : null,
    status: typeof raw.status === 'string' ? raw.status : 'COMPLETED',
    summary: raw.summary,
  };
}
