/**
 * PRD decomposition workflow activities.
 *
 * Four activities back the `prd-decomposition` built-in template:
 *   1. `analyzePrd`            — analyse the PRD for engineering readiness
 *   2. `decomposePrd`          — decompose it into epics + stories
 *   3. `createTrackerItems`    — best-effort creation of tracker tickets
 *   4. `submitPrdWorkRequests` — start a RunnableWorkflow per approved story
 */
import crypto from 'node:crypto';
import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import { createKnowledgeBaseProvider } from '@auto-swe/shared/lib/integrations/registry';
import {
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
} from '@auto-swe/shared/lib/systemConfig';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  type CreatedTrackerItem,
  createTrackerEpic,
  createTrackerStory,
} from '@auto-swe/shared/lib/trackerWrite';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { WorkflowIdReusePolicy } from '@temporalio/client';
import { WorkflowNotFoundError } from '@temporalio/common';
import { z } from 'zod';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { withHeartbeat } from '../lib/execUtils.js';
import { recordWorkerLaunchAudit } from '../lib/launchAudit.js';
import { currentRunLauncherId } from '../lib/runLauncher.js';
import { getTemporalClient } from '../lib/temporalClient.js';
import { allocateTicketWorkflowId } from '../lib/workflowIdAllocation.js';
import { runAgent } from './runAgent.js';
import { NoTemplateForRepoError, resolveTemplateForRepo } from './templates.js';

// ── Structured-output schemas ────────────────────────────────────────────────

const PrdAnalysisSchema = z.object({
  gaps: z
    .array(
      z.object({
        issue: z.string(),
        question: z.string(),
        section: z.string(),
      })
    )
    .default([]),
  readiness: z.enum(['READY', 'NEEDS_CLARIFICATION']),
  summary: z.string(),
});

const PrdStorySchema = z.object({
  acceptanceCriteria: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  description: z.string(),
  repoHint: z.string().optional(),
  storyPoints: z.number().int().min(1).max(8).default(3),
  title: z.string(),
});

const PrdEpicSchema = z.object({
  description: z.string(),
  stories: z.array(PrdStorySchema).default([]),
  title: z.string(),
});

const PrdDecompositionSchema = z.object({
  epics: z.array(PrdEpicSchema).default([]),
  rationale: z.string().default(''),
});

export type PrdAnalysis = z.infer<typeof PrdAnalysisSchema>;
export type PrdStory = z.infer<typeof PrdStorySchema>;
export type PrdEpic = z.infer<typeof PrdEpicSchema>;
export type PrdDecomposition = z.infer<typeof PrdDecompositionSchema>;

export interface TrackerItemsResult {
  createdItems: CreatedTrackerItem[];
  /** Number of items where tracker creation failed (best-effort). */
  failedCount: number;
}

export interface SubmitResult {
  workRequestIds: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface PrdPayload {
  prdTitle: string;
  prdContent: string;
  repoIds: string[];
  knowledgeRepoSources: Array<{ repoId: string; teamId: string; orgId: string }>;
  projectKey?: string | null;
}

export function prdChildSourceSnapshot(
  sources: PrdPayload['knowledgeRepoSources'],
  repo: {
    id: string;
    isActive: boolean;
    teamId: string;
    team: { isActive: boolean; orgId: string; organization: { isActive: boolean } } | null;
  }
) {
  const original = sources.find((source) => source.repoId === repo.id);
  const verified =
    original &&
    repo.isActive &&
    repo.team?.isActive &&
    repo.team.organization.isActive &&
    repo.teamId === original.teamId &&
    repo.team.orgId === original.orgId;
  return verified
    ? {
        knowledgeSourceKind: 'REPOSITORY' as const,
        knowledgeSourceOrgId: original.orgId,
        knowledgeSourceRepoId: original.repoId,
        knowledgeSourceTeamId: original.teamId,
      }
    : {
        knowledgeSourceKind: 'UNKNOWN' as const,
        knowledgeSourceOrgId: null,
        knowledgeSourceRepoId: null,
        knowledgeSourceTeamId: null,
      };
}

export async function createPrdChildRunInputInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string | null;
    data: {
      description: string;
      externalTicketId: string;
      id: string;
      requestPayload: string;
      templateId: string;
      templateVersion: number;
      /** True when the ticket id was generated here rather than taken from a tracker. */
      ticketIsSynthetic?: boolean;
    };
    expected: { repoId: string; teamId: string; orgId: string } | null;
    repoId: string;
    /** The workflow id allocated for this child, recorded as its launch identity. */
    workflowId: string;
  }
): Promise<{ id: string }> {
  let actor: { id: string; isActive: boolean; role: string } | null = null;
  if (input.actorId) {
    // Lock order: exact launcher User → Connection → sorted Teams → sorted Organizations.
    // CLAUDE.md §7 exception: serialize the active/role recheck with user updates.
    const lockedUser = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM users WHERE id = ${input.actorId}::uuid FOR UPDATE`
    );
    actor = lockedUser.length
      ? await tx.user.findUnique({
          select: { id: true, isActive: true, role: true },
          where: { id: input.actorId },
        })
      : null;
  }
  // CLAUDE.md §7 exception: lock the connection before discovering its current owner and shares.
  const lockedRepo = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM connections WHERE id = ${input.repoId}::uuid FOR UPDATE`
  );
  let sourceSnapshot: {
    knowledgeSourceKind: 'UNKNOWN' | 'REPOSITORY';
    knowledgeSourceOrgId: string | null;
    knowledgeSourceRepoId: string | null;
    knowledgeSourceTeamId: string | null;
  } = {
    knowledgeSourceKind: 'UNKNOWN',
    knowledgeSourceOrgId: null,
    knowledgeSourceRepoId: null,
    knowledgeSourceTeamId: null,
  };
  if (lockedRepo.length > 0 && input.expected) {
    const current = await tx.connection.findUnique({
      select: {
        shares: { select: { teamId: true } },
        team: { select: { orgId: true } },
        teamId: true,
      },
      where: { id: input.repoId },
    });
    if (current) {
      const teamIds = [
        ...new Set([
          current.teamId,
          ...current.shares.map((share) => share.teamId),
          input.expected.teamId,
        ]),
      ].sort();
      for (const teamId of teamIds) {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id = ${teamId}::uuid FOR UPDATE`);
      }
      const orgIds = [...new Set([current.team.orgId, input.expected.orgId])].sort();
      for (const orgId of orgIds) {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`
        );
      }
      const actorId = actor?.isActive ? actor.id : null;
      const repo = await tx.connection.findUnique({
        select: {
          id: true,
          isActive: true,
          shares: {
            select: {
              team: {
                select: {
                  isActive: true,
                  memberships: { select: { userId: true }, where: { userId: actorId ?? '' } },
                },
              },
              teamId: true,
            },
          },
          team: {
            select: {
              id: true,
              isActive: true,
              memberships: { select: { userId: true }, where: { userId: actorId ?? '' } },
              organization: { select: { isActive: true } },
              orgId: true,
            },
          },
          teamId: true,
          type: true,
        },
        where: { id: input.repoId },
      });
      const member =
        !!actorId &&
        (repo?.team.memberships.some((row) => row.userId === actorId) ||
          repo?.shares.some(
            (share) =>
              share.team.isActive && share.team.memberships.some((row) => row.userId === actorId)
          ));
      const orgMember =
        actorId && actor?.role !== 'ADMIN'
          ? await tx.organizationMembership.findUnique({
              select: { userId: true },
              where: { userId_orgId: { orgId: input.expected.orgId, userId: actorId } },
            })
          : null;
      const sourceAuthorized =
        !!actorId && !!actor?.isActive && (actor.role === 'ADMIN' || (member && !!orgMember));
      if (
        repo?.isActive &&
        repo.type === 'git_repo' &&
        repo.team.isActive &&
        repo.team.organization.isActive &&
        repo.id === input.expected.repoId &&
        repo.teamId === input.expected.teamId &&
        repo.team.orgId === input.expected.orgId &&
        sourceAuthorized
      ) {
        sourceSnapshot = {
          knowledgeSourceKind: 'REPOSITORY',
          knowledgeSourceOrgId: input.expected.orgId,
          knowledgeSourceRepoId: input.expected.repoId,
          knowledgeSourceTeamId: input.expected.teamId,
        };
      }
    }
  }
  const created = await tx.runInput.create({ data: { ...input.data, ...sourceSnapshot } });
  // Record the launch identity in the same transaction, before any Temporal start: the
  // ledger row is what ties this request to the workflow id it was launched under.
  await claimLaunchRecord(tx, {
    repoId: input.repoId,
    workflowId: input.workflowId,
    workRequestId: input.data.id,
  });
  return created;
}

async function loadPrdPayload(workRequestId: string): Promise<PrdPayload> {
  const run = await prisma.runInput.findUniqueOrThrow({
    select: { knowledgeRepoSources: true, requestPayload: true },
    where: { id: workRequestId },
  });
  const raw = JSON.parse(run.requestPayload) as Partial<PrdPayload>;
  return {
    knowledgeRepoSources: Array.isArray(run.knowledgeRepoSources)
      ? run.knowledgeRepoSources.filter(
          (source): source is { repoId: string; teamId: string; orgId: string } =>
            typeof source === 'object' &&
            source !== null &&
            typeof (source as { repoId?: unknown }).repoId === 'string' &&
            typeof (source as { teamId?: unknown }).teamId === 'string' &&
            typeof (source as { orgId?: unknown }).orgId === 'string'
        )
      : [],
    prdContent: raw.prdContent ?? '',
    prdTitle: raw.prdTitle ?? '',
    projectKey: raw.projectKey ?? null,
    repoIds: Array.isArray(raw.repoIds) ? raw.repoIds : [],
  };
}

// ── Activities ───────────────────────────────────────────────────────────────

/**
 * Analyse the PRD for engineering readiness. Returns a structured analysis
 * including a readiness verdict and a list of gaps/questions for the PM.
 */
export async function analyzePrd(
  request: RepoWorkRequest,
  systemPromptOverride?: string
): Promise<PrdAnalysis> {
  // Heartbeats while the whole activity runs: its LLM call can outlast the
  // heartbeat timeout, and a heartbeat is how a cancellation reaches it.
  return withHeartbeat('analyzePrd', analyzePrdImpl(request, systemPromptOverride));
}

async function analyzePrdImpl(
  request: RepoWorkRequest,
  systemPromptOverride?: string
): Promise<PrdAnalysis> {
  heartbeat('loading PRD payload');
  const payload = await loadPrdPayload(request.workRequestId);

  heartbeat('running prd analyst agent');
  const ctx = await currentRequestContext();
  const spec = await resolveAgentSpec(
    {
      agentKey: 'prdAnalyst' as ModelBackedAgentKey,
      outputSchema: PrdAnalysisSchema,
      promptOverride: systemPromptOverride,
    },
    ctx
  );

  const userMessage = JSON.stringify({
    prdContent: payload.prdContent,
    prdTitle: payload.prdTitle,
    repoIds: payload.repoIds,
  });

  try {
    const result = await runAgent<PrdAnalysis>(spec, userMessage, {
      spanName: 'llm.prd_analyst',
    });
    return result.object ?? { gaps: [], readiness: 'NEEDS_CLARIFICATION', summary: '' };
  } catch {
    return { gaps: [], readiness: 'NEEDS_CLARIFICATION', summary: 'Analysis unavailable.' };
  }
}

/**
 * Decompose the PRD into epics and stories using PM feedback (if any).
 */
export async function decomposePrd(
  request: RepoWorkRequest,
  inputs: { analysis: unknown; pmFeedback?: unknown },
  systemPromptOverride?: string
): Promise<PrdDecomposition> {
  // Heartbeats while the whole activity runs: its LLM call can outlast the
  // heartbeat timeout, and a heartbeat is how a cancellation reaches it.
  return withHeartbeat('decomposePrd', decomposePrdImpl(request, inputs, systemPromptOverride));
}

async function decomposePrdImpl(
  request: RepoWorkRequest,
  inputs: { analysis: unknown; pmFeedback?: unknown },
  systemPromptOverride?: string
): Promise<PrdDecomposition> {
  heartbeat('loading PRD payload');
  const payload = await loadPrdPayload(request.workRequestId);

  heartbeat('running prd decomposer agent');
  const ctx = await currentRequestContext();
  const spec = await resolveAgentSpec(
    {
      agentKey: 'prdDecomposer' as ModelBackedAgentKey,
      outputSchema: PrdDecompositionSchema,
      promptOverride: systemPromptOverride,
    },
    ctx
  );

  const analysis =
    inputs.analysis != null
      ? typeof inputs.analysis === 'string'
        ? inputs.analysis
        : JSON.stringify(inputs.analysis)
      : null;
  const pmFeedback =
    inputs.pmFeedback != null
      ? typeof inputs.pmFeedback === 'string'
        ? inputs.pmFeedback
        : JSON.stringify(inputs.pmFeedback)
      : null;

  const userMessage = JSON.stringify({
    analysis,
    pmFeedback,
    prdContent: payload.prdContent,
    prdTitle: payload.prdTitle,
    repoIds: payload.repoIds,
  });

  try {
    const result = await runAgent<PrdDecomposition>(spec, userMessage, {
      spanName: 'llm.prd_decomposer',
    });
    return result.object ?? { epics: [], rationale: '' };
  } catch {
    return { epics: [], rationale: 'Decomposition unavailable.' };
  }
}

/**
 * Best-effort creation of tracker items (epics + stories) for the given
 * decomposition. Uses `onFail: warn` at the workflow level so any failure here
 * is recorded but does not block the `submitPrdWorkRequests` step.
 */
export async function createTrackerItems(
  request: RepoWorkRequest,
  inputs: { decomposition: unknown }
): Promise<TrackerItemsResult> {
  heartbeat('loading tracker config');
  const [trackerConfig, payload] = await Promise.all([
    resolveIssueTrackerConfig(),
    loadPrdPayload(request.workRequestId),
  ]);

  if (!trackerConfig.provider) {
    return { createdItems: [], failedCount: 0 };
  }

  const decomposition = parseDecomposition(inputs.decomposition);
  const projectKey = payload.projectKey ?? null;
  const createdItems: CreatedTrackerItem[] = [];
  let failedCount = 0;

  for (const epic of decomposition.epics) {
    heartbeat(`creating tracker epic: ${epic.title}`);
    const epicItem = await createTrackerEpic(
      trackerConfig,
      { description: epic.description, title: epic.title },
      projectKey
    );
    if (epicItem) {
      createdItems.push(epicItem);
    } else {
      failedCount++;
    }

    for (const story of epic.stories) {
      heartbeat(`creating tracker story: ${story.title}`);
      const storyItem = await createTrackerStory(
        trackerConfig,
        {
          acceptanceCriteria: story.acceptanceCriteria,
          description: story.description,
          repoHint: story.repoHint,
          storyPoints: story.storyPoints,
          title: story.title,
        },
        projectKey,
        epicItem?.id ?? null
      );
      if (storyItem) {
        createdItems.push(storyItem);
      } else {
        failedCount++;
      }
    }

    // Best-effort Confluence write-back — never blocks tracker item creation.
    try {
      const kbConfig = await resolveKnowledgeBaseConfig();
      const kbProvider = createKnowledgeBaseProvider(kbConfig);
      if (kbProvider) {
        const spaceKey = kbConfig.spaces[0] ?? 'PRD';
        const bodyText = [
          epic.description,
          ...epic.stories.map((s) => `## ${s.title}\n${s.description}`),
        ].join('\n\n');
        const page = await kbProvider.createPage({
          bodyText,
          spaceKey,
          title: `PRD: ${epic.title}`,
        });
        if (page) {
          heartbeat(`KB page created: ${page.url}`);
        }
      }
    } catch {
      // KB write is best-effort — never fails the tracker items activity
    }
  }

  return { createdItems, failedCount };
}

/**
 * The child request id for one story of one PRD submission.
 *
 * Deterministic on purpose, and keyed on the PRD *request* rather than this
 * execution. A Temporal retry re-runs this activity from the start and would
 * otherwise mint new ids for stories it had already submitted, so a failure on
 * story 5 would re-start stories 1–4 as `-rN` reruns of their own completed
 * runs. Keying on the request also makes a restart or reset recover instead of
 * duplicating: stories that already have a ledger row raise P2002 and are
 * reported once, while stories that never got one are still submitted.
 *
 * Shapes follow RFC 4122 version 5 (sha256, version and variant nibbles set) so
 * the value satisfies the column's `uuid` type.
 */
export function prdChildWorkRequestId(prdWorkRequestId: string, storyIndex: number): string {
  const hex = crypto
    .createHash('sha256')
    .update(`prd-child:${prdWorkRequestId}:${storyIndex}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The persisted child submission for one story: its launch arguments, the workflow id
 * it was recorded under, and whether its run materialized.
 *
 * `WorkflowRun.workRequestId` is the durable link for materialization — `createWorkflowRun`
 * writes it on the child's own first activity, for every runnable child. The ledger row
 * written by `createPrdChildRunInputInTransaction` before the start is the launch identity:
 * it names the workflow id this request was launched under, which is what makes recovery
 * exact and a contested ticket attributable.
 */
async function persistedPrdChild(workRequestId: string): Promise<{
  launched: boolean;
  ledgerWorkflowId: string | null;
  requestPayload: string;
} | null> {
  const row = await prisma.runInput.findUnique({
    select: { requestPayload: true },
    where: { id: workRequestId },
  });
  if (!row) {
    return null;
  }
  const [run, ledger] = await Promise.all([
    prisma.workflowRun.findFirst({ select: { id: true }, where: { workRequestId } }),
    prisma.activeWorkflow.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { temporalWorkflowId: true },
      where: { workRequestId },
    }),
  ]);
  return {
    launched: Boolean(run),
    ledgerWorkflowId: ledger?.temporalWorkflowId ?? null,
    requestPayload: row.requestPayload,
  };
}

/**
 * Refuse to reuse a persisted child unless it describes exactly this story.
 *
 * A regenerated decomposition can put a different story at the same position, and
 * the request id is derived from that position, so the mismatch has to be caught
 * here rather than silently reusing the earlier child's repository and content.
 */
function assertSamePrdChild(
  workRequestId: string,
  persistedPayload: string,
  requestPayload: string
): void {
  if (persistedPayload !== requestPayload) {
    throw new Error(
      `PRD child request ${workRequestId} describes different work; refusing to reuse it`
    );
  }
}

/**
 * Claim a workflow id for a child request, or refuse when another request already holds it.
 *
 * `update: {}` never rebinds an existing row, so a successful write proves nothing by itself: a row
 * left by a concurrent attempt keeps its own request. The claim is therefore read back and only
 * accepted when it names this request. Usage, state and finalization all address the ledger by
 * workflow id (`costTracking`, `updateDomainState`, `finalizeWorkflowRun`), so launching under an id
 * whose ledger names somebody else would corrupt them — and inside the child transaction the throw
 * rolls the new request back with it.
 */
async function claimLaunchRecord(
  db: Pick<Prisma.TransactionClient, 'activeWorkflow'>,
  claim: { repoId: string; workflowId: string; workRequestId: string }
): Promise<void> {
  await db.activeWorkflow.upsert({
    create: {
      currentStatus: 'STARTING',
      repoId: claim.repoId,
      temporalWorkflowId: claim.workflowId,
      workRequestId: claim.workRequestId,
    },
    update: {},
    where: { temporalWorkflowId: claim.workflowId },
  });
  const claimed = await db.activeWorkflow.findUnique({
    select: { workRequestId: true },
    where: { temporalWorkflowId: claim.workflowId },
  });
  if (claimed?.workRequestId !== claim.workRequestId) {
    throw new Error(
      `workflow id ${claim.workflowId} is already claimed by another work request; refusing to launch`
    );
  }
}

/**
 * What Temporal says about a recorded launch: running, closed, or never accepted.
 *
 * `describe` is the only way to tell "never accepted" from "closed during setup". Both leave no
 * `WorkflowRun` row — retirement, a missing template and an invalid spec all return before the run
 * row is written — and only the first may be started again under the same id.
 */
async function recordedLaunchState(workflowId: string): Promise<'absent' | 'closed' | 'open'> {
  try {
    const { status } = await getTemporalClient().workflow.getHandle(workflowId).describe();
    // `PAUSED` is still an open execution; every other named status is terminal.
    return status.name === 'RUNNING' || status.name === 'PAUSED' ? 'open' : 'closed';
  } catch (err: unknown) {
    if (err instanceof WorkflowNotFoundError) {
      return 'absent';
    }
    throw err;
  }
}

/**
 * Submit each approved story as an independent implementation work request by
 * starting a `RunnableWorkflow` for each one. Skips stories with no valid repo.
 */
export async function submitPrdWorkRequests(
  request: RepoWorkRequest,
  inputs: { decomposition: unknown; trackerItems?: unknown }
): Promise<SubmitResult> {
  heartbeat('loading repositories');
  const payload = await loadPrdPayload(request.workRequestId);
  const { repoIds, projectKey } = payload;

  if (repoIds.length === 0) {
    return { workRequestIds: [] };
  }

  // Pre-load all target repos so we can match repoHints and generate workflow IDs.
  // The ids come from the PRD work request, whose submit route already checked
  // the caller's access to each one.
  const repos = await runUnscoped('ids already authorised at submit time', ['Connection'], () =>
    prisma.connection.findMany({
      select: {
        githubUrl: true,
        id: true,
        isActive: true,
        organizationName: true,
        repoName: true,
        team: {
          select: { isActive: true, organization: { select: { isActive: true } }, orgId: true },
        },
        teamId: true,
      },
      where: { id: { in: repoIds }, isActive: true, type: 'git_repo' },
    })
  );
  if (repos.length === 0) {
    return { workRequestIds: [] };
  }

  // Preserve the exact parent execution launcher for every child regardless of
  // whether per-user GitHub credentials are enabled. The child uses this identity
  // for scoped knowledge access too; credential resolution independently enforces
  // the per-user credential setting. Read from this execution's run row, never
  // the PRD's stored request, and keep null when the parent has no launcher.
  const launchedById = await currentRunLauncherId();
  // The launch row of a child the platform has started. Called wherever a child is known to be
  // started, including the branches that adopt a launch an earlier attempt made: that attempt may
  // have died between the start and this write, and the helper writes once per request.
  const auditChildLaunch = (workRequestId: string, temporalWorkflowId: string | null) =>
    recordWorkerLaunchAudit({
      actorId: launchedById ?? null,
      details: { temporalWorkflowId, workRequestId },
      entityId: workRequestId,
      entityType: 'WorkRequest',
      source: 'prd-child',
    });

  const repoById = new Map(repos.map((r) => [r.id, r]));

  /** Pick the best repo for a story based on repoHint (contains search). */
  function pickRepo(repoHint?: string | null) {
    if (repoHint) {
      const hint = repoHint.toLowerCase();
      const match = repos.find((r) => {
        const name = (r.repoName ?? '').toLowerCase();
        return name.includes(hint) || hint.includes(name);
      });
      if (match) {
        return match;
      }
    }
    // Fall back to first available repo (repos.length > 0 is checked above).
    return repos[0] as (typeof repos)[0];
  }

  const decomposition = parseDecomposition(inputs.decomposition);
  const trackerItems = parseTrackerItems(inputs.trackerItems);
  // Build a map from story title → tracker item id for externalTicketId generation.
  const storyTicketMap = new Map<string, string>();
  for (const item of trackerItems?.createdItems ?? []) {
    if (item.type === 'story') {
      storyTicketMap.set(item.title.toLowerCase(), item.id);
    }
  }

  const client = getTemporalClient();
  const workRequestIds: string[] = [];
  // Stable across attempts (a retry must regenerate the same fallback ticket id
  // for the same story, or the allocator sees a brand-new ticket and starts a
  // second run). Twelve hex characters of the PRD request id rather than the
  // eight `prdRuns.ts` uses for the PRD's own ticket, because two PRDs colliding
  // here would cross-link their stories.
  const prdPrefix = `PRD-${request.workRequestId.replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  let storyIndex = 0;

  for (const epic of decomposition.epics) {
    for (const story of epic.stories) {
      storyIndex++;
      heartbeat(`submitting story ${storyIndex}: ${story.title}`);

      const repo = pickRepo(story.repoHint);
      const repoInfo = repoById.get(repo.id) ?? repo;

      // Prefer tracker-assigned ID; fall back to a generated one.
      const trackerTicketId = storyTicketMap.get(story.title.toLowerCase());
      const externalTicketId = trackerTicketId ?? `${prdPrefix}-${storyIndex}`;

      const workRequestId = prdChildWorkRequestId(request.workRequestId, storyIndex);
      if (!repoInfo.organizationName || !repoInfo.repoName) {
        // A git connection with no owner/name has nothing a child could clone.
        heartbeat(`story ${storyIndex}: repository ${repo.id} has no owner/name; skipped`);
        continue;
      }
      // Build the description with acceptance criteria appended.
      const description = [
        story.description,
        '',
        `**Epic:** ${epic.title}`,
        story.acceptanceCriteria.length > 0
          ? `\n**Acceptance Criteria:**\n${story.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
          : '',
      ]
        .join('\n')
        .trim();

      // Every immutable launch argument for this story. Serialized identically on
      // every attempt, so it doubles as the submission's content identity: a
      // regenerated decomposition that changes the description, the ticket or the
      // repository produces a different string and is refused below rather than
      // silently reusing the earlier child.
      const requestPayload = JSON.stringify({
        connectionId: repo.id,
        description,
        prdProjectKey: projectKey,
        prdWorkRequestId: request.workRequestId,
        ticketId: externalTicketId,
      });

      // Validate before allocating or starting anything: a persisted child may only
      // be treated as this story's when it still describes exactly this work.
      const persisted = await persistedPrdChild(workRequestId);
      if (persisted) {
        assertSamePrdChild(workRequestId, persisted.requestPayload, requestPayload);
        if (persisted.launched) {
          // Its run materialized, so this story is submitted. Reporting it here is
          // also what stops the allocator's `-rN` from re-running a child that has
          // already finished.
          await auditChildLaunch(workRequestId, persisted.ledgerWorkflowId ?? null);
          workRequestIds.push(workRequestId);
          continue;
        }
      }

      // The launch identity: the id this request was already recorded under, or a
      // freshly allocated one. Re-deriving it on a retry would be guesswork; the launch
      // record written with the request is the only durable statement of it.
      let workflowId: string | null = null;
      let retiredLaunch = false;
      const recordedId = persisted?.ledgerWorkflowId ?? null;
      if (recordedId) {
        const state = await recordedLaunchState(recordedId);
        if (state === 'open') {
          // Accepted and still running: its `WorkflowRun` row simply has not landed yet.
          await auditChildLaunch(workRequestId, recordedId);
          workRequestIds.push(workRequestId);
          continue;
        }
        if (state === 'absent') {
          // Nothing was ever accepted under the recorded id, so replaying it is exact.
          workflowId = recordedId;
        } else {
          // It ran and closed without materializing a run — retirement, a missing template
          // and an invalid spec all return before the run row is written. Recheck
          // materialization under a row lock before deciding: a child that materialized
          // while we were describing it must not be run a second time, and the lock keeps
          // two concurrent recoveries from retiring and replacing the same launch.
          const materialized = await prisma.$transaction(async (tx) => {
            // CLAUDE.md §7 exception: serialize concurrent recoveries of this child.
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM run_inputs WHERE id = ${workRequestId}::uuid FOR UPDATE`
            );
            const run = await tx.workflowRun.findFirst({
              select: { id: true },
              where: { workRequestId },
            });
            if (run) {
              return true;
            }
            await tx.activeWorkflow.updateMany({
              data: { currentStatus: 'FAILED' },
              where: { currentStatus: 'STARTING', temporalWorkflowId: recordedId, workRequestId },
            });
            return false;
          });
          if (materialized) {
            await auditChildLaunch(workRequestId, recordedId);
            workRequestIds.push(workRequestId);
            continue;
          }
          retiredLaunch = true;
        }
      }
      if (!workflowId) {
        // The shared allocator, not a hand-built ID: the base is not unique across
        // repositories, and a collision with another tenant's running workflow
        // would otherwise be swallowed below as "already started".
        const allocation = await allocateTicketWorkflowId({
          externalTicketId,
          // Host-qualified ids and the legacy-id check come from the allocator.
          githubUrl: repoInfo.githubUrl,
          id: repo.id,
          organizationName: repoInfo.organizationName,
          repoName: repoInfo.repoName,
        });
        if ('conflictWorkflowId' in allocation) {
          // A run already holds this ticket. Crediting this story requires proof that
          // run is this child's: the holding ledger row must name this very request.
          // Nothing weaker will do — a tracker ticket is shared with other
          // submissions, and a derived ticket prefix is not a reserved namespace, so
          // two submissions can legitimately arrive at the same ticket. Crediting
          // without proof would report SUCCESS with approved work quietly missing,
          // which is the failure this branch exists to prevent.
          const holder = await prisma.activeWorkflow.findFirst({
            select: { workRequestId: true },
            where: { temporalWorkflowId: allocation.conflictWorkflowId },
          });
          if (holder?.workRequestId === workRequestId) {
            // Ours, but ownership is not acceptance: a concurrent recovery may have claimed
            // this id and died before starting it. Take the id and fall through to the
            // ensure-start path, so an unstarted claim is started and a dead one recovered
            // rather than credited.
            workflowId = allocation.conflictWorkflowId;
          } else {
            throw new Error(
              `PRD story ${storyIndex} cannot use ticket ${externalTicketId}: it is already held ` +
                `by another run (${allocation.conflictWorkflowId})`
            );
          }
        } else {
          workflowId = allocation.workflowId;
        }
      }

      // Resolve the template for this repo.
      let templateId: string;
      let templateVersion: number;
      try {
        const tpl = await resolveTemplateForRepo(repo.id);
        templateId = tpl.templateId;
        templateVersion = tpl.templateVersion;
      } catch (err: unknown) {
        // Only "this repository has no template to run" is a deliberate skip.
        // A database or configuration fault must fail the activity, not report
        // the story as submitted with nothing started.
        if (err instanceof NoTemplateForRepoError) {
          continue;
        }
        throw err;
      }

      if (!workflowId) {
        // Unreachable in practice — every branch above either assigns an id or leaves the
        // loop — but the launch must never proceed without an identity to record it under.
        throw new Error(`PRD story ${storyIndex}: no launch id resolved for ${workRequestId}`);
      }
      // Bound to its own binding: narrowing of the mutable `workflowId` is not preserved
      // inside the transaction callback below, which would see `string | null`.
      let launchId: string = workflowId;

      // Compare the route-authorized tuple, recheck the launching user's membership, and create
      // the child ledger row under one lock-protected transaction. The request payload is not
      // consulted for source identity.
      if (persisted) {
        // The request already exists, so the transaction that would have written its
        // launch record is skipped: claim the id here instead. That covers replaying a
        // never-accepted launch, the fresh id after a retired one, and a request written
        // before launch records existed.
        await claimLaunchRecord(prisma, { repoId: repo.id, workflowId: launchId, workRequestId });
        if (retiredLaunch) {
          heartbeat(`story ${storyIndex}: retired a setup-failed launch, starting ${launchId}`);
        }
      } else {
        try {
          await prisma.$transaction((tx) =>
            createPrdChildRunInputInTransaction(tx, {
              actorId: launchedById,
              data: {
                description,
                externalTicketId,
                id: workRequestId,
                requestPayload,
                templateId,
                templateVersion,
                // Upstream's flag: a synthetic ticket, not a tracker one.
                ticketIsSynthetic: trackerTicketId === undefined,
              },
              expected:
                payload.knowledgeRepoSources.find((source) => source.repoId === repo.id) ?? null,
              repoId: repo.id,
              workflowId: launchId,
            })
          );
        } catch (err: unknown) {
          // Only a unique-constraint conflict is the "already submitted" case this
          // tolerates. Anything else — a lost connection, a lock timeout, a deadlock,
          // a failed source check — must fail the activity so Temporal retries it.
          // Swallowing it would report a work request that has no row and no child run.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) {
            throw err;
          }
          // A concurrent attempt won the request between this attempt's read and its
          // write. Adopt what that attempt recorded rather than starting under this
          // attempt's stale allocation: its row is the durable statement of the launch.
          const winner = await persistedPrdChild(workRequestId);
          if (!winner) {
            throw new Error(`PRD child request ${workRequestId} disappeared during submission`);
          }
          assertSamePrdChild(workRequestId, winner.requestPayload, requestPayload);
          if (winner.launched) {
            await auditChildLaunch(workRequestId, winner.ledgerWorkflowId ?? null);
            workRequestIds.push(workRequestId);
            continue;
          }
          if (winner.ledgerWorkflowId) {
            launchId = winner.ledgerWorkflowId;
          }
          heartbeat(`story ${storyIndex}: adopting the recorded launch for ${workRequestId}`);
        }
      }

      // Start the child workflow. Duplicate workflow IDs throw
      // WorkflowExecutionAlreadyStartedError — skip silently on retry.
      const childRequest: RepoWorkRequest = {
        budgetTier: undefined,
        description,
        externalTicketId,
        ...(launchedById ? { launchedById } : {}),
        repoId: repo.id,
        requestPayload,
        workRequestId,
      };
      try {
        await client.workflow.start('RunnableWorkflow', {
          args: [{ request: childRequest, templateId, templateVersion }],
          taskQueue: 'engineering-workflow',
          workflowId: launchId,
          // Explicit, and deliberately the opposite of the SDK's default: an id that has
          // been used before is refused, never reused. A child that materialized after the
          // last check would otherwise be re-run as a second execution under its closed id
          // (usage, state and finalization all address the ledger by workflow id). Recovery
          // of a setup failure never reaches here with a closed id — that launch is retired
          // above and its replacement id is unused.
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        });
      } catch (err: unknown) {
        const name = err instanceof Error ? err.constructor.name : '';
        if (name !== 'WorkflowExecutionAlreadyStartedError') {
          throw err;
        }
        // A refused start is not a submitted story. Reconcile what happened to the launch:
        // a materialized run or an execution still open means the child is under way; an id
        // that is used yet closed without a run means the child died during setup, and
        // crediting it here would report work that never began. Failing lets the retry take
        // the retirement path above, which retires the dead launch and relaunches.
        const reconciled = await persistedPrdChild(workRequestId);
        if (reconciled?.launched || (await recordedLaunchState(launchId)) === 'open') {
          await auditChildLaunch(workRequestId, launchId);
          workRequestIds.push(workRequestId);
          continue;
        }
        throw new Error(
          `PRD child ${workRequestId} did not launch: ${launchId} is already used and closed ` +
            'without a run'
        );
      }

      await auditChildLaunch(workRequestId, launchId);
      workRequestIds.push(workRequestId);
    }
  }

  return { workRequestIds };
}

// ── Parse helpers (safe coercion for untyped workflow context values) ────────

function parseDecomposition(value: unknown): PrdDecomposition {
  if (value == null) {
    return { epics: [], rationale: '' };
  }
  const parsed = PrdDecompositionSchema.safeParse(value);
  return parsed.success ? parsed.data : { epics: [], rationale: '' };
}

function parseTrackerItems(value: unknown): TrackerItemsResult | null {
  if (value == null) {
    return null;
  }
  const cast = value as Partial<TrackerItemsResult>;
  return {
    createdItems: Array.isArray(cast.createdItems)
      ? (cast.createdItems as CreatedTrackerItem[])
      : [],
    failedCount: typeof cast.failedCount === 'number' ? cast.failedCount : 0,
  };
}
