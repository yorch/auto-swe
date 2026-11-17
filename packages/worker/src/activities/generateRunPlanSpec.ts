/**
 * generateRunPlanSpec — the `run-plan` profile of workflow generation.
 *
 * A launch-time plan is a mandatory skeleton plus free regions. The seeded `workflowAuthor` agent
 * (same Agent row and model as `generateWorkflowSpec`, prompt overridden per call with
 * `WORKFLOW_AUTHOR_RUN_PLAN_PROMPT`) writes ONLY the free regions: the part before the
 * implementation of a delivering plan, or the whole agent / human-review / terminate graph of an
 * output-only plan. It does not author the core: after each parse the platform runs
 * `applySkeletonPolicy` (attach the validate phase and the canonical core) and then, independently,
 * `checkSkeletonPolicy`, `validateSpec` (internal steps NOT allowed), the launchable-agent check
 * and the plan-consistency check. Any error goes back to the model for repair (at most
 * `runPlans.generationMaxAttempts` rounds, default {@link RUN_PLAN_MAX_ATTEMPTS}). Success needs zero errors from all of them, and this activity
 * returns a spec only on success: after the last failed round it throws `GENERATION_FAILED` with no
 * spec at all.
 *
 * The intent is the requester's own text and nothing else (never repository or ticket content),
 * wrapped in delimiters the text cannot close. The catalog the model sees depends on the mode and
 * on the launchable agent list the gateway passes, never on the intent.
 *
 * The settings snapshot is the gateway's (`snapshotPlanSettings`); this activity does not compute it.
 */

import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { WORKFLOW_AUTHOR_RUN_PLAN_PROMPT } from '@auto-swe/shared/lib/agentPrompts';
import { NON_LAUNCHABLE_AGENT_KEYS } from '@auto-swe/shared/lib/agentRun';
import {
  PLANNED_RUN_TEMPLATE_NAME,
  PLANNED_RUN_TEMPLATE_ORIGIN,
  RUN_PLAN_MODES,
  type RunPlanMode,
  runPlanConsistencyIssue,
} from '@auto-swe/shared/lib/plannedRun';
import {
  type AgentPinReader,
  type RunPlanAgentPins,
  resolveRunPlanAgentPins,
  specAgentKeys,
} from '@auto-swe/shared/lib/runPlanAgentPins';
import {
  type AuthoringAgentRef,
  applySkeletonPolicy,
  buildRunPlanRepairMessage,
  buildRunPlanRequestMessage,
  checkSkeletonPolicy,
  estimateRunPlanCost,
  formatValidationIssue,
  parseWorkflowSpec,
  type RunPlanCostEstimate,
  runPlanCatalogHash,
  runPlanIntentIssue,
  type SkeletonIssue,
  type SkeletonReport,
  type ValidationReport,
  validateSpec,
  WorkflowAuthorOutputSchema,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { ownerOfTeam, withSpendOwner } from '../lib/spendOwner.js';
import { runAuthorLoop } from './specAuthorLoop.js';

export interface GenerateRunPlanSpecInput {
  /** The requester's own words. Nothing from a repository or ticket. */
  intent: string;
  mode: RunPlanMode;
  /** The repository's owning team: scope of agent resolution and spend. */
  teamId: string;
  orgId?: string | null;
  /**
   * The agent keys the requester may launch (the gateway resolved them under its access rules).
   * An `agent` node may name only these, and never one on `NON_LAUNCHABLE_AGENT_KEYS`.
   */
  launchableAgentKeys: string[];
  /** The library agent an output-only plan is built on; absent for a delivering plan. */
  agentKey?: string | null;
}

export interface GenerateRunPlanSpecResult {
  /** The full plan: the model's free regions plus the injected validate phase and core. */
  spec: WorkflowSpec;
  mode: RunPlanMode;
  /** The model's one- or two-sentence summary (plain text, may name a gap). */
  summary: string;
  /** Model rounds used (1 = valid on the first try). */
  attempts: number;
  /** `resolveRunPlanAgentPins` over `specAgentKeys(spec)`, the same scope approval uses. */
  agentPins: RunPlanAgentPins;
  /** `runPlanCatalogHash()` at generation time. */
  catalogHash: string;
  costEstimate: RunPlanCostEstimate;
  /** `checkSkeletonPolicy` on the returned spec (zero errors; may carry warnings). */
  skeletonReport: SkeletonReport;
  /** `validateSpec` on the returned spec (zero errors; may carry warnings). */
  validationReport: ValidationReport;
  /** Ids of the nodes the platform added (validate phase, core). */
  injected: string[];
  /** The `<provider>/<model>` the author ran on, for the plan record. */
  model: string;
}

/**
 * Generate → repair rounds when the `runPlans.generationMaxAttempts` setting cannot be read (1..5,
 * default 3). Each round is one (costly) LLM call.
 */
export const RUN_PLAN_MAX_ATTEMPTS = 3;

/** The per-plan round cap for this team and organization; a setting that cannot be read is the default. */
async function resolveMaxAttempts(input: Pick<GenerateRunPlanSpecInput, 'teamId' | 'orgId'>) {
  try {
    const value = await resolveSetting('runPlans.generationMaxAttempts', {
      ...(input.orgId ? { orgId: input.orgId } : {}),
      teamId: input.teamId,
    });
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : RUN_PLAN_MAX_ATTEMPTS;
  } catch (err) {
    logWarn('run plan generation attempts setting unreadable; using the default', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return RUN_PLAN_MAX_ATTEMPTS;
  }
}

function agentKeyOf(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at === -1 ? ref : ref.slice(0, at);
}

function formatSkeletonIssue(issue: SkeletonIssue): string {
  return `[${issue.code}] ${issue.message}`;
}

/** The catalog's agents: the requester's launchable keys that have an active library row. */
async function loadCatalogAgents(
  input: Pick<GenerateRunPlanSpecInput, 'teamId' | 'orgId' | 'launchableAgentKeys'>
): Promise<AuthoringAgentRef[]> {
  const keys = [...new Set(input.launchableAgentKeys)].filter(
    (k) => !NON_LAUNCHABLE_AGENT_KEYS.has(k)
  );
  if (keys.length === 0) {
    return [];
  }
  const rows = await prisma.agent.findMany({
    // TEAM sorts after GLOBAL, so scope DESC keeps the most specific label when deduping.
    orderBy: [{ key: 'asc' }, { scope: 'desc' }],
    select: { description: true, key: true, name: true },
    where: {
      isActive: true,
      key: { in: keys },
      OR: [
        { scope: 'GLOBAL' as const, teamId: null },
        { scope: 'TEAM' as const, teamId: input.teamId },
        ...(input.orgId ? [{ orgId: input.orgId, scope: 'ORGANIZATION' as const }] : []),
      ],
    },
  });
  const byKey = new Map<string, AuthoringAgentRef>();
  for (const row of rows) {
    if (!byKey.has(row.key)) {
      byKey.set(row.key, { description: row.description, key: row.key, name: row.name });
    }
  }
  return [...byKey.values()];
}

async function plannedRunTemplateId(): Promise<string> {
  const template = await prisma.workflowTemplate.findFirst({
    select: { id: true },
    where: {
      name: PLANNED_RUN_TEMPLATE_NAME,
      origin: PLANNED_RUN_TEMPLATE_ORIGIN,
      status: 'ACTIVE',
      teamId: null,
    },
  });
  if (!template) {
    throw ApplicationFailure.nonRetryable(
      'The Planned Run system template is not installed; run the database seed',
      'PLANNED_RUN_TEMPLATE_MISSING'
    );
  }
  return template.id;
}

function invalidInput(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, 'PLAN_INPUT_INVALID');
}

export async function generateRunPlanSpec(
  input: GenerateRunPlanSpecInput
): Promise<GenerateRunPlanSpecResult> {
  // No run row: the spend is the requesting team's.
  return withSpendOwner(ownerOfTeam(input.teamId), () => generateRunPlanSpecImpl(input));
}

async function generateRunPlanSpecImpl(
  input: GenerateRunPlanSpecInput
): Promise<GenerateRunPlanSpecResult> {
  if (!(RUN_PLAN_MODES as readonly string[]).includes(input.mode)) {
    throw invalidInput('unknown plan mode');
  }
  // The same rule the gateway applied: the text the author sees is the text the plan stores, so
  // an over-long intent or one carrying the wrapper's own tag is refused, never cut or rewritten.
  const intentIssue = runPlanIntentIssue(input.intent);
  if (intentIssue) {
    throw invalidInput(intentIssue);
  }
  if (typeof input.teamId !== 'string' || input.teamId === '') {
    throw invalidInput('the plan has no team to attribute its spend to');
  }
  const mismatch = runPlanConsistencyIssue({ agentKey: input.agentKey, mode: input.mode });
  if (mismatch) {
    throw invalidInput(mismatch);
  }
  const launchable = new Set(
    input.launchableAgentKeys.filter((k) => !NON_LAUNCHABLE_AGENT_KEYS.has(k))
  );
  if (input.agentKey && !launchable.has(input.agentKey)) {
    throw invalidInput(`the agent '${input.agentKey}' is not launchable by the requester`);
  }

  const maxAttempts = await resolveMaxAttempts(input);

  heartbeat('generate run plan: building catalog');
  const agents = await loadCatalogAgents(input);
  const catalogInput = { agentKey: input.agentKey ?? null, agents, mode: input.mode };
  const templateId = await plannedRunTemplateId();

  // Same Agent row and model as the general author; only the prompt is the run-plan one.
  const agentSpec = await resolveAgentSpec(
    {
      agentKey: 'workflowAuthor' as ModelBackedAgentKey,
      outputSchema: WorkflowAuthorOutputSchema,
      promptOverride: WORKFLOW_AUTHOR_RUN_PLAN_PROMPT,
    },
    { orgId: input.orgId ?? undefined, teamId: input.teamId }
  );

  type Accepted = Omit<GenerateRunPlanSpecResult, 'attempts' | 'summary'>;

  const loop = await runAuthorLoop<Accepted>({
    accept: async (authored) => {
      // Attach the validate phase and the canonical core. The model's own text never reaches
      // the core except through the two named slots the policy allows.
      const applied = applySkeletonPolicy(authored, input.mode);
      const candidate = applied.spec;
      const errors: string[] = applied.report.errors.map(formatSkeletonIssue);

      // The check run on its own, as approval will run it: independent of apply's own report.
      const skeletonReport = checkSkeletonPolicy(candidate, input.mode);
      for (const issue of skeletonReport.errors) {
        const line = formatSkeletonIssue(issue);
        if (!errors.includes(line)) {
          errors.push(line);
        }
      }

      const validationReport = validateSpec(candidate, { allowInternalSteps: false });
      errors.push(...validationReport.errors.map(formatValidationIssue));

      // Agents outside the requester's launchable set (validateSpec only knows the global list).
      for (const [id, node] of Object.entries(candidate.nodes)) {
        if (node.type === 'agent') {
          const key = agentKeyOf(node.agentRef);
          if (!launchable.has(key)) {
            errors.push(
              `[AGENT_NOT_LAUNCHABLE] agent node '${id}' names '${key}', which is not in the list of agents you may name`
            );
          }
        }
      }

      const consistency = runPlanConsistencyIssue(
        { agentKey: input.agentKey, mode: input.mode },
        candidate
      );
      if (consistency) {
        errors.push(`[PLAN_AGENT_MISMATCH] ${consistency}`);
      }

      // What gets stored is parsed again: the spec must survive the schema after injection.
      if (errors.length === 0) {
        try {
          parseWorkflowSpec(structuredClone(candidate));
        } catch {
          errors.push('[SPEC_INVALID] the plan with its mandatory nodes does not parse');
        }
      }
      if (errors.length > 0) {
        return { errors, ok: false };
      }

      // Pins last: resolution costs queries and the plan is final by now.
      const refs = specAgentKeys(candidate);
      const pins = await resolveRunPlanAgentPins(prisma as unknown as AgentPinReader, refs, {
        orgId: input.orgId ?? null,
        teamId: input.teamId,
        workflowTemplateId: templateId,
      });
      const missing = Object.entries(pins).filter(([, pin]) => pin === null);
      if (missing.length > 0) {
        const authoredRefs = [
          ...new Set(
            Object.values(candidate.nodes).flatMap((n) => (n.type === 'agent' ? [n.agentRef] : []))
          ),
        ];
        const reader = prisma as unknown as AgentPinReader;
        const scope = {
          orgId: input.orgId ?? null,
          teamId: input.teamId,
          workflowTemplateId: templateId,
        };
        // A core or step agent that is not configured cannot be fixed by rewriting the free part.
        const platformRefs = refs.filter((ref) => !authoredRefs.includes(ref));
        const platformPins = await resolveRunPlanAgentPins(reader, platformRefs, scope);
        const platformMissing = Object.entries(platformPins)
          .filter(([, pin]) => pin === null)
          .map(([ref]) => ref);
        if (platformMissing.length > 0) {
          throw ApplicationFailure.nonRetryable(
            `agents the plan relies on are not available: ${platformMissing.join(', ')}`,
            'AGENTS_UNAVAILABLE'
          );
        }
        // An authored agent is unusable when it, or the parent its model is inherited from, has no
        // active version. That is repairable: name the agent so the model picks another.
        const unusable: string[] = [];
        for (const ref of authoredRefs) {
          const own = await resolveRunPlanAgentPins(reader, [ref], scope);
          if (Object.values(own).some((pin) => pin === null)) {
            unusable.push(ref);
          }
        }
        if (unusable.length === 0) {
          throw ApplicationFailure.nonRetryable(
            `agents the plan relies on are not available: ${missing.map(([ref]) => ref).join(', ')}`,
            'AGENTS_UNAVAILABLE'
          );
        }
        return {
          errors: unusable.map(
            (ref) =>
              `[AGENT_UNAVAILABLE] agent '${ref}' is unusable right now (it or the agent it takes its model from has no active version); use another agent`
          ),
          ok: false,
        };
      }

      return {
        ok: true,
        value: {
          agentPins: pins as RunPlanAgentPins,
          catalogHash: runPlanCatalogHash(),
          costEstimate: estimateRunPlanCost(candidate),
          injected: applied.injected,
          mode: input.mode,
          model: agentSpec.modelSpec,
          skeletonReport,
          spec: candidate,
          validationReport,
        },
      };
    },
    agentSpec,
    buildRepair: (errors, previousSpecJson) =>
      buildRunPlanRepairMessage(catalogInput, {
        errors,
        intent: input.intent,
        previousSpecJson,
      }),
    heartbeatLabel: 'generate run plan',
    initialMessage: buildRunPlanRequestMessage(catalogInput, input.intent),
    maxAttempts,
    spanName: 'llm.run_plan_author',
  });

  if (!loop.ok) {
    throw ApplicationFailure.nonRetryable(
      `the run plan could not be generated after ${maxAttempts} attempts: ${loop.errors.join('; ')}`,
      'GENERATION_FAILED',
      { attempts: loop.attempts, errors: loop.errors }
    );
  }
  return { ...loop.value, attempts: loop.attempts, summary: loop.summary };
}
