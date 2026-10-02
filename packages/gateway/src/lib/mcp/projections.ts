import { z } from 'zod';
import { isValidTicketId } from '../ticketId.js';

/**
 * What a tool result may carry, and nothing else.
 *
 * An MCP result goes into a model's context, so anything written by another person (a ticket
 * description, a requester's name, a step's error text, a trace) is a prompt-injection channel.
 * Every projection here is therefore an explicit allowlist, built in two layers: the schema that
 * reads the REST body names only the fields we use (so an added REST field cannot reach a tool by
 * accident), and the schema of the result is the shape clients are told about. Free text never
 * appears: identifiers, enums, numbers, timestamps, one validated URL, and the few short names
 * team members author (a template, a node, a human step's title), clipped and stripped of control
 * characters.
 */

/** C0 and C1 controls and the Unicode line and paragraph separators. */
const isControl = (code: number) =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;

const withoutControls = (s: string) =>
  [...s].map((ch) => (isControl(ch.codePointAt(0) as number) ? ' ' : ch)).join('');

/** A short name authored by a team member: no control characters, at most `max` characters. */
export const shortName = (max: number) =>
  z.string().transform((s) => withoutControls(s).trim().slice(0, max));

/** An enum-like status from the REST body; anything that is not one is reported as UNKNOWN. */
const status = z.string().transform((s) => (/^[A-Z][A-Z_]{0,31}$/.test(s) ? s : 'UNKNOWN'));

/** A ticket id that satisfies the charset the submit route enforces; anything else is dropped. */
const ticketId = z.string().transform((s) => (isValidTicketId(s) ? s : null));

const timestamp = z.string().max(40);
const nullableTimestamp = timestamp
  .nullable()
  .optional()
  .transform((v) => v ?? null);

/** A Prisma `Decimal` arrives as a string or a number; the tool reports a number. */
const money = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .pipe(z.number().finite());

const count = z.coerce.number().int().min(0);

// ── What the REST routes return, reduced to the fields a tool uses ──

const meta = z.object({ limit: z.number(), offset: z.number(), total: z.number() });

const workRequestRef = z
  .object({ externalTicketId: ticketId, id: z.string().uuid() })
  .nullable()
  .optional()
  .transform((v) => v ?? null);

export const restRepositories = z.object({
  data: z.array(
    z.object({
      defaultBranch: shortName(200),
      id: z.string().uuid(),
      isActive: z.boolean(),
      organizationName: shortName(200).nullable(),
      repoName: shortName(200).nullable(),
      team: z
        .object({ id: z.string().uuid(), name: shortName(200), slug: shortName(100) })
        .nullable(),
      type: z.string(),
    })
  ),
  meta,
});

export const restWorkRequests = z.object({
  data: z.array(
    z.object({
      activeWorkflows: z.array(z.object({ currentStatus: status, id: z.string().uuid() })),
      createdAt: timestamp,
      externalTicketId: ticketId,
      id: z.string().uuid(),
      requestedBy: z
        .object({ id: z.string() })
        .nullable()
        .optional()
        .transform((v) => v ?? null),
    })
  ),
  meta,
});

export const restRuns = z.object({
  data: z.array(
    z.object({
      costUsdAccrued: money,
      endedAt: nullableTimestamp,
      id: z.string().uuid(),
      startedAt: timestamp,
      status,
      templateName: shortName(200).nullable(),
      workRequest: workRequestRef,
    })
  ),
  meta,
});

export const restRun = z.object({
  data: z.object({
    costUsdAccrued: money,
    endedAt: nullableTimestamp,
    id: z.string().uuid(),
    result: z.unknown().optional(),
    startedAt: timestamp,
    status,
    steps: z.array(z.object({ attempt: count, nodeId: shortName(100), status })),
    templateName: shortName(200),
    tokensInputTotal: count,
    tokensOutputTotal: count,
    workRequest: workRequestRef,
  }),
});

export const restHumanSteps = z.object({
  data: z.array(
    z.object({
      currentApprovers: count,
      id: z.string().uuid(),
      kind: shortName(50),
      nodeId: shortName(100),
      requestedAt: timestamp,
      requiredApprovers: count,
      runId: z.string().uuid(),
      timeoutAt: nullableTimestamp,
      title: shortName(200),
    })
  ),
});

// ── What a tool returns ──

const page = { limit: z.number().int(), offset: z.number().int(), total: z.number().int() };
const ticketRef = z.object({ externalTicketId: z.string().nullable(), id: z.string() }).nullable();

export const repositoriesOutput = z.object({
  repositories: z.array(
    z.object({
      defaultBranch: z.string(),
      id: z.string(),
      isActive: z.boolean(),
      organizationName: z.string().nullable(),
      repoName: z.string().nullable(),
      team: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
    })
  ),
  ...page,
});

export const workRequestsOutput = z.object({
  workRequests: z.array(
    z.object({
      activeWorkflows: z.array(z.object({ id: z.string(), status: z.string() })),
      createdAt: z.string(),
      externalTicketId: z.string().nullable(),
      id: z.string(),
      isMine: z.boolean(),
    })
  ),
  ...page,
});

export const runsOutput = z.object({
  runs: z.array(
    z.object({
      costUsdAccrued: z.number(),
      endedAt: z.string().nullable(),
      id: z.string(),
      startedAt: z.string(),
      status: z.string(),
      templateName: z.string().nullable(),
      workRequest: ticketRef,
    })
  ),
  ...page,
});

export const runOutput = z.object({
  costUsdAccrued: z.number(),
  dashboardUrl: z.string(),
  endedAt: z.string().nullable(),
  id: z.string(),
  result: z.object({ prNumber: z.number().int(), prUrl: z.string() }).nullable(),
  startedAt: z.string(),
  status: z.string(),
  steps: z.array(
    z.object({
      attempt: z.number().int(),
      failed: z.boolean(),
      nodeId: z.string(),
      status: z.string(),
    })
  ),
  templateName: z.string(),
  tokensInputTotal: z.number().int(),
  tokensOutputTotal: z.number().int(),
  workRequest: ticketRef,
});

export const humanStepsOutput = z.object({
  humanSteps: z.array(
    z.object({
      currentApprovers: z.number().int(),
      id: z.string(),
      inboxUrl: z.string(),
      kind: z.string(),
      nodeId: z.string(),
      requestedAt: z.string(),
      requiredApprovers: z.number().int(),
      runId: z.string(),
      timeoutAt: z.string().nullable(),
      title: z.string(),
    })
  ),
});

const MAX_PR_URL_LENGTH = 500;

/**
 * A run's outcome, reduced to exactly `{ prUrl, prNumber }` or null.
 *
 * `result` is whatever the workflow's terminate node mapped, so it is an arbitrary object. Only a
 * positive integer and an `https` URL with no credentials in it pass; the rest, however plausible,
 * is dropped.
 */
export function projectRunResult(result: unknown): { prNumber: number; prUrl: string } | null {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  const { prUrl, prNumber } = result as Record<string, unknown>;
  if (
    typeof prUrl !== 'string' ||
    prUrl.length > MAX_PR_URL_LENGTH ||
    !Number.isSafeInteger(prNumber) ||
    (prNumber as number) < 1
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return null;
  }
  return { prNumber: prNumber as number, prUrl: url.href };
}

export type RepositoriesOutput = z.infer<typeof repositoriesOutput>;
export type WorkRequestsOutput = z.infer<typeof workRequestsOutput>;
export type RunsOutput = z.infer<typeof runsOutput>;
export type RunOutput = z.infer<typeof runOutput>;
export type HumanStepsOutput = z.infer<typeof humanStepsOutput>;
