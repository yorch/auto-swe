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
import { prisma } from '@auto-swe/shared/db';
import { createKnowledgeBaseProvider } from '@auto-swe/shared/lib/integrations/registry';
import { resolveIssueTrackerConfig, resolveKnowledgeBaseConfig } from '@auto-swe/shared/lib/systemConfig';
import {
  type CreatedTrackerItem,
  createTrackerEpic,
  createTrackerStory,
} from '@auto-swe/shared/lib/trackerWrite';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { z } from 'zod';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { getTemporalClient } from '../lib/temporalClient.js';
import { runAgent } from './runAgent.js';
import { resolveTemplateForRepo } from './templates.js';

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
  projectKey?: string | null;
}

async function loadPrdPayload(workRequestId: string): Promise<PrdPayload> {
  const run = await prisma.runInput.findUniqueOrThrow({
    select: { requestPayload: true },
    where: { id: workRequestId },
  });
  const raw = JSON.parse(run.requestPayload) as Partial<PrdPayload>;
  return {
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
  const repos = await prisma.connection.findMany({
    select: { id: true, organizationName: true, repoName: true, teamId: true },
    where: { id: { in: repoIds }, isActive: true, type: 'git_repo' },
  });
  if (repos.length === 0) {
    return { workRequestIds: [] };
  }

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
  const prdPrefix = `PRD-${Date.now()}`;
  let storyIndex = 0;

  for (const epic of decomposition.epics) {
    for (const story of epic.stories) {
      storyIndex++;
      heartbeat(`submitting story ${storyIndex}: ${story.title}`);

      const repo = pickRepo(story.repoHint);
      const repoInfo = repoById.get(repo.id) ?? repo;

      // Prefer tracker-assigned ID; fall back to a generated one.
      const externalTicketId =
        storyTicketMap.get(story.title.toLowerCase()) ?? `${prdPrefix}-${storyIndex}`;

      const workRequestId = crypto.randomUUID();
      const workflowId = `eng-${repoInfo.organizationName}-${repoInfo.repoName}-${externalTicketId}`;

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

      const requestPayload = JSON.stringify({
        connectionId: repo.id,
        description,
        prdProjectKey: projectKey,
        prdWorkRequestId: request.workRequestId,
        ticketId: externalTicketId,
      });

      // Resolve the template for this repo.
      let templateId: string;
      let templateVersion: number;
      try {
        const tpl = await resolveTemplateForRepo(repo.id);
        templateId = tpl.templateId;
        templateVersion = tpl.templateVersion;
      } catch {
        // No template for this repo — skip it.
        continue;
      }

      // Persist the RunInput first (idempotent: skip if already created).
      try {
        await prisma.runInput.create({
          data: {
            description,
            externalTicketId,
            id: workRequestId,
            requestPayload,
            templateId,
            templateVersion,
          },
        });
      } catch {
        // Duplicate — already submitted on a Temporal retry; still count it.
        workRequestIds.push(workRequestId);
        continue;
      }

      // Start the child workflow. Duplicate workflow IDs throw
      // WorkflowExecutionAlreadyStartedError — skip silently on retry.
      const childRequest: RepoWorkRequest = {
        budgetTier: undefined,
        description,
        externalTicketId,
        repoId: repo.id,
        requestPayload,
        workRequestId,
      };
      try {
        await client.workflow.start('RunnableWorkflow', {
          args: [{ request: childRequest, templateId, templateVersion }],
          taskQueue: 'engineering-workflow',
          workflowId,
        });
      } catch (err: unknown) {
        const name = err instanceof Error ? err.constructor.name : '';
        if (name !== 'WorkflowExecutionAlreadyStartedError') {
          throw err;
        }
      }

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
