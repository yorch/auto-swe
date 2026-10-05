import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_SCANNER_PATTERNS, scannerPatternOrigin } from '../scannerPatterns/index.js';
import { BUILTIN_SKILLS } from '../skills/index.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import {
  BRAND_REVIEWER_PROMPT,
  CHANNEL_ASSISTANT_PROMPT,
  CI_FIX_SYSTEM_PROMPT,
  CONTENT_WRITER_PROMPT,
  CONTEXT_VALIDATOR_PROMPT,
  DECOMPOSER_AGENT_PROMPT,
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  GATE_FIX_SYSTEM_PROMPT,
  IMPLEMENTER_SYSTEM_PROMPT,
  ISSUE_DRAFTER_PROMPT,
  LESSON_CONSOLIDATOR_PROMPT,
  MEMORY_SUMMARIZER_PROMPT,
  MERGE_CONFLICT_RESOLVER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  PLANNER_AGENT_PROMPT,
  PRD_ANALYST_PROMPT,
  PRD_DECOMPOSER_PROMPT,
  PRD_WRITER_PROMPT,
  PRODUCT_ANALYST_PROMPT,
  REVIEW_FIX_SYSTEM_PROMPT,
  SECURITY_AUDITOR_PROMPT,
  SECURITY_REVIEW_PROMPT,
  SUPPORT_RESPONDER_PROMPT,
  WORKFLOW_AUTHOR_PROMPT,
  WORKFLOW_EXPLAINER_PROMPT,
} from './agentPrompts.js';
import { AGENT_RUN_SPEC, AGENT_RUN_TEMPLATE_NAME, AGENT_RUN_TEMPLATE_ORIGIN } from './agentRun.js';
import { BUILTIN_MODELS, builtinModelSpec } from './builtinModels.js';
import {
  CHANNEL_ASSISTANT_SPEC,
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from './channelTask.js';
import {
  initialRevision,
  isRevisionConflict,
  nextRevision,
  skillContentChanged,
  skillContentHash,
} from './skillRevision.js';
import { runUnscoped } from './tenantGuard.js';

/** Provenance tag for all SWE seed content. */
const SWE_ORIGIN = 'swe-starter';

/**
 * Name of the GLOBAL workflow template that backs channel-assistant observability.
 *
 * Channel workflows (`ChannelAssistantWorkflow` / `ChannelAmbientWorkflow`) are not
 * driven by the spec interpreter, but they DO call LLM activities that persist
 * `AgentTrace` rows — and a trace row needs a `WorkflowRun` to attach to (the FK on
 * `AgentTrace.runId`, and `currentWorkflowRunId()` resolves the run by Temporal
 * workflowId). The worker creates a lightweight `WorkflowRun` per channel turn keyed
 * to this template so those traces are visible in `/runs`. The template's spec is a
 * single terminal node — the run is a trace container, not an interpreted graph.
 *
 * The name is the stable lookup key (`findFirst({ name, teamId: null })`) the worker
 * uses to resolve this template's id + active version at run time. The name
 * constant lives in `./channelTask.js` (re-exported here for compatibility).
 */
export {
  CHANNEL_ASSISTANT_SPEC,
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  CHANNEL_TASK_TEMPLATE_NAME,
} from './channelTask.js';

/**
 * Channel assistant: `WorkflowSpec` for the GLOBAL "Channel Task" template — a
 * general agentic task launched from a channel @mention.
 *
 * Conditional decomposition (general-route): a `planChannelTask` step first
 * decides whether the task splits into independent parts. It is biased AGAINST
 * splitting, so cohesive tasks (the common case) come back as ONE subtask and the
 * `decide` cond routes to the single `task` agent node — behaviourally the same as
 * before, plus one cheap planning call. Genuinely parallelizable tasks (2..N
 * subtasks) go to the `composite` step (`runChannelSubtasks`), which runs one
 * `channelAssistant` pass per subtask with bounded concurrency (a dud subtask never
 * sinks the task) and then synthesizes the partial answers into one reply. The fan
 * runs inside that activity rather than as engine `fanOut` nodes because the
 * interpreter's fan-out cannot surface a branch agent's free-text output to the
 * join (branch outputs are stored under prefixed ids); an activity has full control
 * over parallelism + synthesis, and each subtask/synth call is still a traced LLM run.
 *
 * Either path's answer text is surfaced as the run result and posted back in-thread
 * by `finalizeChannelTaskRun`, which reads `nodes.composite.output.text` (decompose
 * path) falling back to `nodes.task.output.text` (single path). Typed loosely
 * (object literal) so this file doesn't depend on the workflow-spec package; it is
 * parsed/validated wherever it's consumed (`createWorkflowRun` → `parseWorkflowSpec`).
 */
export const CHANNEL_TASK_SPEC = {
  description:
    'General agentic task launched from a Slack channel @mention. Plans whether the ' +
    "task decomposes, runs the channel's assistant (single or fanned-out), and reports back in-thread.",
  entry: 'plan',
  name: CHANNEL_TASK_TEMPLATE_NAME,
  nodes: {
    // 2b. Decompose path: run each subtask + synthesize inside one activity.
    composite: {
      inputs: {
        subtasks: { from: 'nodes.plan.output.subtasks' },
        task: { from: 'request.description' },
      },
      next: 'doneMulti',
      step: 'runChannelSubtasks',
      type: 'step',
    },
    decide: {
      expr: 'nodes.plan.output.subtaskCount > 1',
      onFalse: 'task',
      onTrue: 'composite',
      type: 'cond',
    },
    done: {
      result: { result: { from: 'nodes.task.output.text' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    doneMulti: {
      result: { result: { from: 'nodes.composite.output.text' } },
      status: 'SUCCESS',
      type: 'terminate',
    },
    // 1. Decide whether to decompose. Biased toward a single subtask.
    plan: {
      inputs: { task: { from: 'request.description' } },
      next: 'decide',
      spanName: 'llm.channel_task.plan',
      step: 'planChannelTask',
      type: 'step',
    },

    // 2a. Single-agent path (cohesive task).
    task: {
      agentRef: 'channelAssistant',
      inputs: { task: { from: 'request.description' } },
      next: 'done',
      spanName: 'llm.channel_task',
      type: 'agent',
    },
  },
  schemaVersion: 1,
} as const;

/**
 * Upserts all built-in reference data — split by provenance so a future
 * deployment can run the platform without the SWE use case:
 *
 *   - {@link seedCoreDefaults} — domain-agnostic platform defaults that always
 *     seed and survive a "core-only" deployment (the cross-cutting scanner
 *     patterns: injection / exfiltration / shell-command / sensitive-file).
 *     These rows carry `origin = null`.
 *   - {@link seedSweStarter} — the SWE use case as seed content: workflow
 *     templates, coding skills, the first-class Agents (model/skills/tools) +
 *     their skillRefs, and the SWE-specific code-security scanner patterns.
 *     Every row is tagged `origin = 'swe-starter'` so it is distinguishable
 *     and removable.
 *
 * Safe to call on every startup. What an admin owns is created when missing and
 * otherwise left alone: a template's status / default flag / active version, an
 * agent's versions and skill refs. A changed built-in template spec lands as a
 * new version (see {@link syncBuiltinTemplate}). Scanner patterns upsert by the
 * `label` unique index, preserving `isActive`.
 */
export async function syncBuiltins(prisma: PrismaClient): Promise<void> {
  await seedCoreDefaults(prisma);
  await seedSweStarter(prisma);
}

/** Core platform defaults (origin=null). Always seeded. */
export async function seedCoreDefaults(prisma: PrismaClient): Promise<void> {
  await backfillSkillRevisions(prisma);
  await syncScannerPatterns(prisma, 'core');
  await syncAutonomyPolicies(prisma);
  await syncModelCatalog(prisma);
}

/**
 * Seed the model catalog from {@link BUILTIN_MODELS}. Code owns a built-in row
 * until an admin edits it: an untouched one is kept in step, so a price
 * corrected in code reaches every deployment on restart, while a customized one
 * is never overwritten. An admin's own row for a model that later ships
 * built-in is adopted as built-in and customized, keeping the admin's prices.
 * Nothing is deleted — a model dropped from code still prices its history.
 */
export async function syncModelCatalog(prisma: PrismaClient): Promise<void> {
  const existing = new Map(
    (await prisma.modelCatalogEntry.findMany()).map((r) => [`${r.provider}/${r.modelId}`, r])
  );
  for (const model of BUILTIN_MODELS) {
    const fromCode = {
      inputUsdPerMTok: model.inputUsdPerMTok,
      kind: model.kind,
      outputUsdPerMTok: model.outputUsdPerMTok,
      status: model.status,
    };
    const row = existing.get(builtinModelSpec(model));
    if (!row) {
      try {
        await prisma.modelCatalogEntry.create({
          data: { ...fromCode, isBuiltIn: true, modelId: model.modelId, provider: model.provider },
        });
      } catch (err) {
        // A gateway booting alongside this one inserted it first.
        if (!isUniqueViolation(err)) {
          throw err;
        }
      }
    } else if (!row.isBuiltIn) {
      await prisma.modelCatalogEntry.update({
        data: { isBuiltIn: true, isCustomized: true },
        where: { id: row.id },
      });
    } else if (
      !row.isCustomized &&
      (row.inputUsdPerMTok !== fromCode.inputUsdPerMTok ||
        row.outputUsdPerMTok !== fromCode.outputUsdPerMTok ||
        row.kind !== fromCode.kind ||
        row.status !== fromCode.status)
    ) {
      await prisma.modelCatalogEntry.update({ data: fromCode, where: { id: row.id } });
    }
  }
}

/** SWE starter content (origin='swe-starter'). Opt-out-able in the future. */
export async function seedSweStarter(prisma: PrismaClient): Promise<void> {
  await syncTemplates(prisma);
  await syncChannelAssistantTemplate(prisma);
  await syncChannelTaskTemplate(prisma);
  await syncAgentRunTemplate(prisma);
  const newSkillNames = await syncSkills(prisma);
  await syncScannerPatterns(prisma, 'swe');
  await syncAgents(prisma, newSkillNames);
  await syncEvalRubrics(prisma);
}

/**
 * Seed a GLOBAL channel template (the "Channel Assistant" observability shell or
 * the "Channel Task" autonomous-execution substrate) through the same versioned,
 * admin-preserving path as {@link syncTemplates}. Both rows are distinct from the
 * SWE templates in `BUILTIN_TEMPLATES` on purpose — never offered as a
 * run-on-submit option, so not worth carrying through the BuiltinTemplate list.
 */
async function syncGlobalChannelTemplate(
  prisma: PrismaClient,
  name: string,
  spec: { description: string }
): Promise<void> {
  await syncBuiltinTemplate(prisma, {
    description: spec.description,
    isDefault: false,
    name,
    spec,
  });
}

/** Seed the GLOBAL "Channel Assistant" observability-shell template (single v1 spec). */
async function syncChannelAssistantTemplate(prisma: PrismaClient): Promise<void> {
  await syncGlobalChannelTemplate(prisma, CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_ASSISTANT_SPEC);
}

/** Seed the GLOBAL "Channel Task" autonomous-execution template (Phase A; single v1 spec). */
async function syncChannelTaskTemplate(prisma: PrismaClient): Promise<void> {
  await syncGlobalChannelTemplate(prisma, CHANNEL_TASK_TEMPLATE_NAME, CHANNEL_TASK_SPEC);
}

/**
 * Seed the hidden "Agent Run" system template behind `POST /api/v1/agent-runs`.
 *
 * Unlike the channel templates this row is the platform's, not the admin's: it is
 * hidden and locked in the gateway, so there is no admin edit to preserve and the
 * newest built-in version is always the active one. It carries a dedicated
 * `system:` origin rather than `swe-starter`, and the sync only ever touches a
 * row that already carries it. A GLOBAL row of the same name that does NOT (an
 * admin created it first) is left strictly alone and reported: appending the
 * system spec to somebody else's template would hand its owner the system step,
 * and the gateway answers a launch with a clear "template missing" instead.
 */
export async function syncAgentRunTemplate(prisma: PrismaClient): Promise<void> {
  const spec = AGENT_RUN_SPEC as unknown as object;
  const existing = await prisma.workflowTemplate.findFirst({
    where: { name: AGENT_RUN_TEMPLATE_NAME, teamId: null },
  });

  if (!existing) {
    try {
      await prisma.workflowTemplate.create({
        data: {
          activeVersion: 1,
          description: AGENT_RUN_SPEC.description,
          isDefault: false,
          name: AGENT_RUN_TEMPLATE_NAME,
          origin: AGENT_RUN_TEMPLATE_ORIGIN,
          status: 'ACTIVE',
          teamId: null,
          versions: { create: { spec, version: 1 } },
          workspaceProvider: 'git_repo',
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
    return;
  }

  if (existing.origin !== AGENT_RUN_TEMPLATE_ORIGIN) {
    console.error(
      `[syncBuiltins] a GLOBAL template named '${AGENT_RUN_TEMPLATE_NAME}' exists without the system origin; ` +
        'agent runs are unavailable until it is renamed or removed'
    );
    return;
  }

  const latest = await prisma.workflowTemplateVersion.findFirst({
    orderBy: { version: 'desc' },
    select: { spec: true, version: true },
    where: { templateId: existing.id },
  });
  if (latest && canonicalJson(latest.spec) === canonicalJson(spec)) {
    if (existing.activeVersion !== latest.version || existing.status !== 'ACTIVE') {
      await prisma.workflowTemplate.update({
        data: { activeVersion: latest.version, status: 'ACTIVE' },
        where: { id: existing.id },
      });
    }
    return;
  }
  const next = (latest?.version ?? 0) + 1;
  try {
    await prisma.workflowTemplateVersion.create({
      data: { spec, templateId: existing.id, version: next },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return; // another replica appended the same spec first
    }
    throw err;
  }
  await prisma.workflowTemplate.update({
    data: { activeVersion: next, status: 'ACTIVE' },
    where: { id: existing.id },
  });
}

/** The built-in code-review-quality judge rubric (evals P2). Idempotent. */
const BUILTIN_RUBRICS: ReadonlyArray<{ slug: string; promptText: string; scale: string }> = [
  {
    promptText: [
      'Grade the candidate diff on these axes (each contributes to the overall score):',
      '- Correctness of intent: does it solve the stated ticket? (the hidden tests are the tiebreaker)',
      '- Scope: a minimal change, or did it touch unrelated code?',
      '- Readability: would a senior engineer approve this in review?',
      '- Safety: any injected risk, secrets, or unsafe shell/file operations?',
      'Return { "score": 0..1, "rationale": string } where score is the overall quality.',
    ].join('\n'),
    scale: '0..1',
    slug: 'code-review-quality',
  },
  {
    promptText: [
      'You are a brand reviewer checking a draft against voice, tone, and clarity standards.',
      'Check for off-brand tone, jargon, passive voice, unsupported claims, accessibility issues, or formatting problems.',
      'Return { "score": 0..1, "rationale": string } where score reflects how on-brand and clear the draft is.',
    ].join('\n'),
    scale: '0..1',
    slug: 'brand-voice',
  },
  {
    promptText: [
      'You are a factual checker reviewing a draft for unsupported or inaccurate claims.',
      'Flag any assertions that lack evidence, contradict the provided context, or introduce invented details.',
      'Return { "score": 0..1, "rationale": string } where score reflects factual reliability.',
    ].join('\n'),
    scale: '0..1',
    slug: 'factual-claims',
  },
];

async function syncEvalRubrics(prisma: PrismaClient): Promise<void> {
  for (const r of BUILTIN_RUBRICS) {
    const existing = await prisma.evalRubric.findFirst({
      where: { isBuiltIn: true, scope: 'GLOBAL', slug: r.slug },
    });
    if (existing) {
      await prisma.evalRubric.update({
        data: { promptText: r.promptText, scale: r.scale },
        where: { id: existing.id },
      });
    } else {
      await prisma.evalRubric.create({
        data: {
          isBuiltIn: true,
          promptText: r.promptText,
          scale: r.scale,
          scope: 'GLOBAL',
          slug: r.slug,
        },
      });
    }
  }
}

/**
 * The SWE agent keys as first-class GLOBAL `Agent` rows — the single source of
 * truth for model / skills / tools (P1.5). Model-backed roles carry a default
 * `modelSpec`; sub-roles carry `inheritsModelFrom`; the implementer carries its
 * `toolKeys`. Skill refs are synced from `BUILTIN_SKILLS` assignments. The
 * credential is still resolved by provider from `ProviderCredential` at run
 * time, so a fresh deploy only needs the admin to add a credential.
 */
export interface SweAgentDef {
  key: string;
  name: string;
  description: string;
  /** Default `<provider>/<model>` for model-backed roles. */
  modelSpec?: string;
  /** Parent agent key this persona inherits its model from (sub-roles only). */
  inheritsModelFrom?: string;
  /** Tool keys this agent may use (null/omitted = all candidate tools). */
  toolKeys?: string[];
  /** Base system prompt / persona for this agent. */
  systemPrompt: string;
}

const IMPLEMENTER_TOOLS = ['readFile', 'writeFile', 'listDirectory', 'bash'];

/**
 * P3 repo-dependency-graph: infers likely cross-repo edges from repo metadata
 * (names, descriptions, languages, package names, manifest hints) so an
 * operator can review/confirm them instead of hand-declaring every edge.
 * Structured-output coupling — `inferRepoDependencies` parses the result with
 * a Zod schema, and separately re-validates candidate membership, self-edges,
 * confidence range, and edge kind before writing anything — so a stray or
 * malformed edge here is dropped downstream rather than trusted outright.
 */
const REPO_DEPENDENCY_INFERRER_PROMPT = `You are a Repo Dependency Inferrer. You receive metadata for one "subject" repository plus a fixed CANDIDATE LIST of other repositories in the same organization — names, descriptions, languages, declared package names, and any manifest hints available. Your job is to propose likely dependency relationships between the subject repo and repos in the candidate list, so an operator can review and confirm them.

RULES (read carefully — violating any of these makes your output unusable):
1. Only propose edges where the other endpoint is a repo id taken verbatim from the supplied CANDIDATE LIST. Never invent a repo, and never reference a repo id you were not given.
2. Never propose a self-edge (the subject repo depending on itself).
3. Be conservative. A relationship must be reasonably inferable from the given metadata — a shared naming convention, a description that names the other repo or its package, a language/ecosystem pairing that strongly implies a client/server or library/consumer relationship, or an explicit mention. When in doubt, omit the edge rather than guess.
4. Assign each edge a "kind" — one of: code, runtime, build, api, data — describing the nature of the dependency (code: imports/shares code; runtime: calls it at runtime, e.g. a service dependency; build: needed to build/compile; api: consumes its API/contract; data: reads/writes its data).
5. Assign a confidence between 0 and 1 reflecting how certain you are: 0.9+ only for near-certain, clearly evidenced relationships; 0.5-0.8 for a plausible but not fully confirmed relationship; below 0.5 for a weak guess (prefer omitting these unless the signal is still worth surfacing to a human).
6. Give a short, concrete one- or two-sentence rationale for each edge, citing the specific evidence (e.g. "subject repo's description names this package as a dependency").
7. Return an empty edges array if nothing in the candidate list is plausibly related to the subject repo — do not force a relationship just to have something to report.

You MUST respond with valid JSON matching this schema:
{
  "edges": [
    { "toRepoId": "<a repo id taken from the CANDIDATE LIST>", "kind": "code" | "runtime" | "build" | "api" | "data", "confidence": 0..1, "rationale": "short evidence-based explanation" }
  ]
}`;

export const SWE_AGENTS: ReadonlyArray<SweAgentDef> = [
  {
    description: 'Writes code in the workspace via the TDD loop.',
    key: 'implementer',
    modelSpec: 'anthropic/claude-opus-5-5',
    name: 'Implementer',
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    toolKeys: IMPLEMENTER_TOOLS,
  },
  {
    description: 'Reviews diffs through the multi-agent review network.',
    key: 'reviewer',
    modelSpec: 'anthropic/claude-opus-5-5',
    name: 'Reviewer',
    systemPrompt: DOMAIN_LOGIC_REVIEWER_PROMPT,
  },
  {
    description: 'Decomposes work into an implementation plan.',
    key: 'planner',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Planner',
    systemPrompt: PLANNER_AGENT_PROMPT,
  },
  {
    description: 'Post-diff security gate — CRITICAL findings fail the activity.',
    key: 'securityReview',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Security Review',
    systemPrompt: SECURITY_REVIEW_PROMPT,
  },
  {
    description: 'Extracts success criteria from the work request.',
    key: 'validateContext',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Context Validator',
    systemPrompt: CONTEXT_VALIDATOR_PROMPT,
  },
  {
    description: 'Commits lessons to semantic memory.',
    key: 'commitToMemory',
    modelSpec: 'anthropic/claude-opus-5-5',
    name: 'Memory Committer',
    systemPrompt: MEMORY_SUMMARIZER_PROMPT,
  },
  {
    // Channel assistant (Phase 0): the shared, per-channel Slack assistant. Model-backed
    // so each channel can resolve its own model via the CHANNEL config tier; the
    // GLOBAL row seeded here is the default the cascade falls back to.
    description: 'Shared per-channel Slack teammate that answers @mentions in-thread.',
    key: 'channelAssistant',
    modelSpec: 'anthropic/claude-opus-5-5',
    name: 'Channel Assistant',
    systemPrompt: CHANNEL_ASSISTANT_PROMPT,
  },
  {
    // Evals P2 (RFC §9): the judge model MUST differ from the implementer's
    // (self-preference bias), so this is seeded with a cheaper, distinct model.
    // Not in MODEL_BACKED_AGENT_KEYS, so it doesn't gate worker boot; the rubric
    // is injected per-call as the system prompt (this base is a fallback).
    description: 'LLM-as-judge for eval rubric scoring (model differs from implementer).',
    key: 'evalJudge',
    modelSpec: 'anthropic/claude-haiku-4-5-20251001',
    name: 'Eval Judge',
    systemPrompt:
      'You are an impartial code-review judge. Score the candidate output against the ' +
      'provided rubric and return the requested JSON. Be calibrated and concise.',
  },
  {
    // Natural-language workflow authoring: turns a plain-language intent into a
    // valid WorkflowSpec. Model-backed (its own modelSpec) so it prices + gets a
    // model-config label, but intentionally NOT in MODEL_BACKED_AGENT_KEYS — no
    // workflow STEP resolves it, so it must not gate worker boot (resolved on
    // demand by the generateWorkflowSpec activity, like evalJudge).
    description: 'Generates a WorkflowSpec from a natural-language description.',
    key: 'workflowAuthor',
    modelSpec: 'anthropic/claude-opus-5-5',
    name: 'Workflow Author',
    systemPrompt: WORKFLOW_AUTHOR_PROMPT,
  },
  {
    // Inverse of workflowAuthor: summarizes an existing spec in plain language.
    // A cheaper model is plenty for read-and-describe; resolved on demand (not
    // in MODEL_BACKED_AGENT_KEYS, so it never gates worker boot).
    description: 'Explains an existing WorkflowSpec in plain language.',
    key: 'workflowExplainer',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Workflow Explainer',
    systemPrompt: WORKFLOW_EXPLAINER_PROMPT,
  },
  {
    // Content/Comms pack (Phase 2): drafts prose for document workspaces such as Notion.
    // Resolved on demand by the generic `agent` node, so it is not in
    // MODEL_BACKED_AGENT_KEYS and does not gate worker boot.
    description:
      'Drafts concise prose for a document workspace from source material and instructions.',
    key: 'contentWriter',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Content Writer',
    systemPrompt: CONTENT_WRITER_PROMPT,
  },
  {
    // Product pack (Phase 2): drafts issue descriptions from a brief for issue trackers.
    // Resolved on demand by the generic `agent` node, so it is not in
    // MODEL_BACKED_AGENT_KEYS and does not gate worker boot.
    description: 'Drafts a focused issue description from a brief for Linear or Jira.',
    key: 'issueDrafter',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Issue Drafter',
    systemPrompt: ISSUE_DRAFTER_PROMPT,
  },
  {
    // Content/Comms pack (Phase 2): checks drafts against brand voice, tone, and clarity.
    // Resolved on demand by the generic `agent` node, so it is not in
    // MODEL_BACKED_AGENT_KEYS and does not gate worker boot.
    description:
      'Reviews a draft for brand voice, clarity, and accessibility, returning a concise revision.',
    key: 'brandReviewer',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Brand Reviewer',
    systemPrompt: BRAND_REVIEWER_PROMPT,
  },
  {
    // Support/Ops pack (Phase 2): drafts responses to support tickets.
    // Resolved on demand by the generic `agent` node, so it is not in
    // MODEL_BACKED_AGENT_KEYS and does not gate worker boot.
    description: 'Drafts empathetic, policy-aware responses to support tickets.',
    key: 'supportResponder',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Support Responder',
    systemPrompt: SUPPORT_RESPONDER_PROMPT,
  },
  {
    // Product pack (Phase 2): turns a brief into structured product analysis.
    // Resolved on demand by the generic `agent` node, so it is not in
    // MODEL_BACKED_AGENT_KEYS and does not gate worker boot.
    description: 'Analyzes a problem brief and produces structured product thinking.',
    key: 'productAnalyst',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'Product Analyst',
    systemPrompt: PRODUCT_ANALYST_PROMPT,
  },
  {
    // Product pack (Phase 2): drafts a lightweight PRD with acceptance criteria.
    // Resolved on demand by the generic `agent` node, so it is not in
    // MODEL_BACKED_AGENT_KEYS and does not gate worker boot.
    description: 'Drafts a focused PRD with testable acceptance criteria from product analysis.',
    key: 'prdWriter',
    modelSpec: 'anthropic/claude-sonnet-5-5',
    name: 'PRD Writer',
    systemPrompt: PRD_WRITER_PROMPT,
  },
  {
    // P3 repo-dependency-graph: proposes LLM-inferred cross-repo edges for
    // human review. Cheap/fast model — same as evalJudge — since this is a
    // structured-classification task over a bounded candidate list, not
    // open-ended reasoning. Not in MODEL_BACKED_AGENT_KEYS: no workflow STEP
    // resolves it (it's called directly from the `inferRepoDependencies`
    // activity), so it must not gate worker boot — resolved on demand, like
    // evalJudge and workflowAuthor/workflowExplainer above.
    description: 'Infers likely cross-repo dependency edges from repo metadata for human review.',
    key: 'repoDependencyInferrer',
    modelSpec: 'anthropic/claude-haiku-4-5-20251001',
    name: 'Repo Dependency Inferrer',
    systemPrompt: REPO_DEPENDENCY_INFERRER_PROMPT,
  },
  {
    description: 'Security-focused sub-reviewer in the review network.',
    inheritsModelFrom: 'reviewer',
    key: 'securityReviewer',
    name: 'Security Reviewer',
    systemPrompt: SECURITY_AUDITOR_PROMPT,
  },
  {
    description: 'Domain-logic sub-reviewer in the review network.',
    inheritsModelFrom: 'reviewer',
    key: 'domainLogicReviewer',
    name: 'Domain Logic Reviewer',
    systemPrompt: DOMAIN_LOGIC_REVIEWER_PROMPT,
  },
  {
    description: 'Performance-focused sub-reviewer in the review network.',
    inheritsModelFrom: 'reviewer',
    key: 'performanceReviewer',
    name: 'Performance Reviewer',
    systemPrompt: PERFORMANCE_REVIEWER_PROMPT,
  },
  {
    description: 'Breaks an epic into subtasks.',
    inheritsModelFrom: 'planner',
    key: 'decomposer',
    name: 'Decomposer',
    systemPrompt: DECOMPOSER_AGENT_PROMPT,
  },
  {
    description: 'Consolidates clusters of similar lessons into generalised insights.',
    inheritsModelFrom: 'commitToMemory',
    key: 'lessonConsolidator',
    name: 'Lesson Consolidator',
    systemPrompt: LESSON_CONSOLIDATOR_PROMPT,
  },
  {
    description: 'Fixes CI failures on the implementer branch.',
    inheritsModelFrom: 'implementer',
    key: 'ciFixer',
    name: 'CI Fixer',
    systemPrompt: CI_FIX_SYSTEM_PROMPT,
    toolKeys: IMPLEMENTER_TOOLS,
  },
  {
    description: 'Addresses review findings on the implementer branch.',
    inheritsModelFrom: 'implementer',
    key: 'reviewFixer',
    name: 'Review Fixer',
    systemPrompt: REVIEW_FIX_SYSTEM_PROMPT,
    toolKeys: IMPLEMENTER_TOOLS,
  },
  {
    description: 'Fixes quality-gate failures on the implementer branch.',
    inheritsModelFrom: 'implementer',
    key: 'gateFixer',
    name: 'Gate Fixer',
    systemPrompt: GATE_FIX_SYSTEM_PROMPT,
    toolKeys: IMPLEMENTER_TOOLS,
  },
  {
    description: 'Resolves merge conflicts when rebasing the implementer branch.',
    inheritsModelFrom: 'implementer',
    key: 'mergeConflictResolver',
    name: 'Merge Conflict Resolver',
    systemPrompt: MERGE_CONFLICT_RESOLVER_PROMPT,
    toolKeys: IMPLEMENTER_TOOLS,
  },
  // ── PRD workflow agents ────────────────────────────────────────────────────
  {
    description: 'Analyzes a PRD for engineering readiness: gaps, ambiguities, missing NFRs.',
    inheritsModelFrom: 'planner',
    key: 'prdAnalyst',
    name: 'PRD Analyst',
    systemPrompt: PRD_ANALYST_PROMPT,
  },
  {
    description: 'Decomposes a PRD into epics and stories with acceptance criteria.',
    inheritsModelFrom: 'planner',
    key: 'prdDecomposer',
    name: 'PRD Decomposer',
    systemPrompt: PRD_DECOMPOSER_PROMPT,
  },
];

/** Build `agentKey → [{ skillName, sortOrder }]` from the built-in skill assignments. */
function skillsByAgentKey(): Map<string, Array<{ name: string; sortOrder: number }>> {
  const map = new Map<string, Array<{ name: string; sortOrder: number }>>();
  for (const skill of BUILTIN_SKILLS) {
    for (const a of skill.assignments) {
      const list = map.get(a.role) ?? [];
      list.push({ name: skill.name, sortOrder: a.sortOrder });
      map.set(a.role, list);
    }
  }
  return map;
}

/**
 * Seeded model defaults this file used to ship, mapped to the default that
 * replaced them. A GLOBAL built-in Agent whose latest version still carries the
 * old value — and whose key now defaults to the mapped value — is an untouched
 * seed, so {@link syncAgents} moves it forward. Any other value is an admin's
 * choice and is never rewritten.
 */
export const PREVIOUS_DEFAULT_MODEL_SPECS: Readonly<Record<string, string>> = {
  'anthropic/claude-opus-4-8': 'anthropic/claude-opus-5-5',
  'anthropic/claude-sonnet-4-6': 'anthropic/claude-sonnet-5-5',
};

type AgentRow = NonNullable<Awaited<ReturnType<PrismaClient['agent']['findFirst']>>>;

/**
 * Move an untouched seeded Agent onto its key's current default model. Cuts a
 * new version rather than editing in place, exactly as the agent library does
 * for an admin's model change: a run pins the GLOBAL version it started on
 * (`WorkflowRun.agentVersions`), so rewriting that version would swap the model
 * under an in-flight run. Returns the row later syncing should target.
 */
async function migrateSeededModelDefault(
  prisma: PrismaClient,
  def: SweAgentDef,
  current: AgentRow
): Promise<AgentRow> {
  if (
    !def.modelSpec ||
    !current.isActive ||
    !current.isBuiltIn ||
    current.modelSpec === null ||
    PREVIOUS_DEFAULT_MODEL_SPECS[current.modelSpec] !== def.modelSpec
  ) {
    return current;
  }
  return prisma.$transaction(async (tx) => {
    const next = await tx.agent.create({
      data: {
        channelId: current.channelId,
        credentialId: current.credentialId,
        description: current.description,
        inheritsModelFrom: current.inheritsModelFrom,
        isActive: true,
        isBuiltIn: current.isBuiltIn,
        isVerified: current.isVerified,
        key: current.key,
        mcpConnectionId: current.mcpConnectionId,
        modelSpec: def.modelSpec,
        name: current.name,
        orgId: current.orgId,
        origin: current.origin,
        scope: current.scope,
        systemPrompt: current.systemPrompt,
        teamId: current.teamId,
        toolKeys: current.toolKeys ?? undefined,
        version: current.version + 1,
        workflowTemplateId: current.workflowTemplateId,
      },
    });
    const refs = await tx.agentSkillRef.findMany({
      orderBy: { sortOrder: 'asc' },
      select: { skillId: true, sortOrder: true },
      where: { agentId: current.id },
    });
    if (refs.length > 0) {
      await tx.agentSkillRef.createMany({
        data: refs.map((ref) => ({ agentId: next.id, ...ref })),
      });
    }
    return next;
  });
}

/**
 * Create-if-missing for the built-in GLOBAL agents. An existing agent is the
 * admin's: its versions, activation and skill refs are never rewritten here.
 * The one exception is an untouched seed — a latest version still carrying a
 * model this file used to ship — which {@link migrateSeededModelDefault} moves
 * onto the new default as a NEW version, leaving the old one for run pins.
 *
 * Skill refs are attached when the agent is created, and — for an existing
 * agent — only for built-in skills that `syncSkills` created in this same run
 * (`newSkillNames`). A ref to a skill that already existed and is missing now
 * was removed by an admin, and re-adding it on every boot would undo that. A
 * migrated version copies its predecessor's refs, so it keeps those removals.
 */
async function syncAgents(prisma: PrismaClient, newSkillNames: ReadonlySet<string>): Promise<void> {
  const skillMap = skillsByAgentKey();
  for (const def of SWE_AGENTS) {
    // The newest version, deterministically — not whichever row the planner
    // returns first. It has to be the true latest, not merely an active one:
    // the model migration cuts `version + 1` from this row, and anything older
    // would collide with a version that already exists.
    let agent = await prisma.agent.findFirst({
      orderBy: { version: 'desc' },
      where: { key: def.key, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
    });
    const created = !agent;
    if (!agent) {
      agent = await prisma.agent.create({
        data: {
          description: def.description,
          inheritsModelFrom: def.inheritsModelFrom ?? null,
          isBuiltIn: true,
          isVerified: true,
          key: def.key,
          modelSpec: def.modelSpec ?? null,
          name: def.name,
          origin: SWE_ORIGIN,
          scope: 'GLOBAL',
          systemPrompt: def.systemPrompt,
          toolKeys: def.toolKeys ?? undefined,
          version: 1,
        },
      });
    } else {
      if (!agent.systemPrompt) {
        // One-time migration: backfill systemPrompt for existing rows that predate
        // this change. Skipped once an admin has set a custom value.
        agent = await prisma.agent.update({
          data: { systemPrompt: def.systemPrompt },
          where: { id: agent.id },
        });
      }
      agent = await migrateSeededModelDefault(prisma, def, agent);
    }

    for (const want of skillMap.get(def.key) ?? []) {
      if (!created && !newSkillNames.has(want.name)) {
        continue;
      }
      const skill = await prisma.skill.findFirst({
        where: { isBuiltIn: true, name: want.name },
      });
      if (!skill) {
        continue;
      }
      const existingRef = await prisma.agentSkillRef.findFirst({
        where: { agentId: agent.id, skillId: skill.id },
      });
      if (!existingRef) {
        await prisma.agentSkillRef.create({
          data: { agentId: agent.id, skillId: skill.id, sortOrder: want.sortOrder },
        });
      }
    }
  }
}

/**
 * Built-in templates seeded under an earlier name, `old → new`.
 *
 * Sync matches a GLOBAL template by name, so renaming one in code alone would
 * create a second row and strand the first — along with its run history, its
 * versions, and every team override pointing at it. This renames the existing
 * row in place first. Entries stay until no deployment can still hold the old
 * name; removing one early re-creates the duplicate.
 */
export const RENAMED_TEMPLATES: Readonly<Record<string, string>> = {
  // It opens a PR and stops at green CI; the old name said it merged.
  'review-and-merge': 'agent-reviewed-pr',
};

/**
 * Earlier built-in descriptions, by current template name.
 *
 * Sync never overwrites a template's description, because an admin may have
 * edited it. A row still carrying one of these exact strings was never edited,
 * so it is safe to bring up to date — same rule as the `systemPrompt` backfill
 * in {@link syncAgents}.
 */
export const SUPERSEDED_TEMPLATE_DESCRIPTIONS: Readonly<Record<string, readonly string[]>> = {
  [CHANNEL_ASSISTANT_TEMPLATE_NAME]: [
    'Observability shell for channel-assistant turns and ambient digests. ' +
      'Not interpreted — a lightweight run is created per channel turn so its ' +
      'agent traces (LLM calls) are visible in the run viewer.',
  ],
  'agent-reviewed-pr': [
    'Implement, run the automated review network (up to 3 attempts), open a PR, then wait for CI. No human approval steps, and it never merges: the run ends when CI is green and the pull request waits for a person. Use this when the agent review loop is a sufficient quality gate before a PR.',
    'Implement, run the automated review network (up to 3 attempts), open a PR, then wait ' +
      'for CI. Fully automated — no human approval steps. Use this when the agent review ' +
      'loop is sufficient quality gate before a PR.',
  ],
  'canary-rollout': [
    'Implement, review (up to 3 agent attempts), open PR, wait for CI, then pause for a staging-deploy signal and finally a production-monitoring signal. Models a canary/release-train pipeline where each promotion stage must be explicitly confirmed by an external system before proceeding.',
  ],
  'code-and-ci': [
    'Fully automated: implement, run lint + typecheck + tests locally, open a PR, then loop on CI failures (fetch logs → fix → push) up to 3 times. No review network, no human approval. Use for low-risk, well-tested codebases.',
  ],
  'consensus-review': [
    'Implement, open the PR and wait for CI (a failing CI is fixed by the agent: 2 fix attempts, and a third failure fails the run), then run two independent agent review-network calls in parallel (fanOut with concurrency=2) on the code that passed CI. Both reviewers must approve; if either rejects the agent addresses the combined feedback, CI runs again, and both reviewers run again (up to 3 rounds). Demonstrates fanOut for parallel quality gates rather than parallel work.',
    'Run two independent agent review-network calls in parallel (fanOut with concurrency=2). Both reviewers must approve before the PR opens; if either rejects the agent addresses the combined feedback and tries again (up to 3 rounds). Demonstrates fanOut for parallel quality gates rather than parallel work.',
  ],
  'default-engineering': [
    'Default engineering workflow (parity with hardcoded EngineeringWorkflow).',
  ],
  'dependency-update': [
    'Implement the dependency update, run the full test suite, open a PR, then loop on CI failures (fetch logs → fix → push) up to 3 times. Skips the review network — tests and CI are the quality gate for mechanical dep bumps.',
  ],
  'full-supervised': [
    'The kitchen-sink supervised workflow: collect requirements upfront, implement, show the diff for review, let the reviewer decide whether to apply their notes, then require final approval before the PR is opened. Demonstrates all four HITL node types in sequence.',
  ],
  hotfix: [
    'Fastest possible path from ticket to open PR. Implement, run lint + typecheck (in warn mode so they never block), then open the PR immediately — no review network, no CI wait, no human approval. Intended for P0 production incidents only.',
  ],
  'human-code-review': [
    'Implement, lint, typecheck, then show the diff to a human reviewer before opening the PR. The reviewer can leave notes and the agent will address them, or approve the diff as-is.',
  ],
  migration: [
    'Implement the migration code, execute a dry-run inside an ephemeral container to preview the SQL, then require a human to review and approve the plan before the PR is opened. Demonstrates the shell node paired with humanApproval contextFrom.',
  ],
  'model-catalog-refresh': [
    "Keep the built-in model catalog current: list each provider's live model ids through the platform, read the official pricing pages, update BUILTIN_MODELS with a cited source for every changed price, and open a DRAFT pull request for a person to review. Uncertain figures are left unchanged and called out. A run with nothing to change, or whose previous pull request is still open, opens none. Point it at your auto-swe fork and schedule it.",
  ],
  'parallel-fan-out': [
    'Validate context, split the work into three parallel branches (feature implementation, tests, documentation), merge them into one integration branch (resolving conflicts with the merge-conflict agent if needed), then open a single PR. Each branch runs an isolated executeImplementation agent. Demonstrates the fanOut node with concurrency=3, pluck, and merge.',
  ],
  'pr-approval-gate': [
    'Implement, run tests, then require explicit human approval before opening the PR. Useful when a human must sign off on every change before it becomes visible to reviewers.',
  ],
  'scope-clarification': [
    'Ask a human for additional context before the agent starts implementing. Useful for tickets whose descriptions are intentionally vague or too high-level for the agent to act on without guidance.',
  ],
  'security-triage': [
    'Implement, run a vulnerability scan, then ask a human how to proceed. Three paths: fix the issues immediately, accept the risk and open the PR anyway, or abandon the change entirely.',
  ],
  'signal-gated-rollout': [
    'Implement, run the agent review loop, open a PR, wait for CI, then pause for a deployment-gate signal from an external system (CD pipeline, change-management board). The gate signal carries an approval flag; rejection or timeout terminates the run.',
  ],
  'tiered-escalation': [
    'After implementation, a human categorises the change risk (low / medium / high). Low-risk changes go straight to PR; medium require senior sign-off; high-risk changes require team-lead approval with a 48-hour window.',
  ],
};

async function renameTemplates(prisma: PrismaClient): Promise<void> {
  for (const [from, to] of Object.entries(RENAMED_TEMPLATES)) {
    const legacy = await prisma.workflowTemplate.findFirst({ where: { name: from, teamId: null } });
    if (!legacy) {
      continue;
    }
    const current = await prisma.workflowTemplate.findFirst({ where: { name: to, teamId: null } });
    if (current) {
      // Both exist — the new one was created before this rename ran. Leave the
      // legacy row for an admin rather than guess which history to keep.
      console.warn(
        `[syncBuiltins] template "${from}" was renamed to "${to}", but both exist; ` +
          `leaving "${from}" (${legacy.id}) for an admin to archive`
      );
      continue;
    }
    await prisma.workflowTemplate.update({ data: { name: to }, where: { id: legacy.id } });
  }
}

async function syncTemplates(prisma: PrismaClient): Promise<void> {
  await renameTemplates(prisma);
  for (const tmpl of BUILTIN_TEMPLATES) {
    // Legacy SWE templates predate the column and expect a git workspace.
    await syncBuiltinTemplate(prisma, {
      ...tmpl,
      workspaceProvider: tmpl.workspaceProvider ?? 'git_repo',
    });
  }
}

/** JSON with object keys sorted, so a `jsonb` round trip compares equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]])
        )
      : v
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/**
 * Sync one built-in GLOBAL template without overwriting what an admin owns.
 *
 * - **Missing** → create it at v1, ACTIVE. It becomes the global default only
 *   when the definition asks for it AND no global default exists yet: there is
 *   never a second one.
 * - **Present** → `status`, `isDefault` and `activeVersion` are the admin's and
 *   are left alone, and no existing version is rewritten (a run pins its
 *   version; rewriting v1 in place changed the graph under it).
 * - **Built-in spec changed** → append a NEW version. A built-in version is one
 *   with no author (`createdBy` and `generatedBy` both null — every version a
 *   user or the author agent saves carries one). The new version is activated,
 *   together with the template-level built-in fields (`inputSchema`,
 *   `workspaceProvider`), only when the template is still active on the
 *   previous built-in version: an admin who moved it to their own version, or
 *   archived it, keeps that choice.
 *
 * Safe under concurrent gateway boots: a version-number clash means another
 * replica appended the same spec first.
 */
async function syncBuiltinTemplate(
  prisma: PrismaClient,
  tmpl: {
    name: string;
    description: string;
    spec: unknown;
    isDefault?: boolean;
    inputSchema?: unknown;
    workspaceProvider?: string;
  }
): Promise<void> {
  const spec = tmpl.spec as object;
  const templateFields = {
    ...(tmpl.inputSchema ? { inputSchema: tmpl.inputSchema as object } : {}),
    ...(tmpl.workspaceProvider ? { workspaceProvider: tmpl.workspaceProvider } : {}),
  };
  const existing = await prisma.workflowTemplate.findFirst({
    where: { name: tmpl.name, teamId: null },
  });

  if (!existing) {
    const defaultTaken = tmpl.isDefault
      ? await prisma.workflowTemplate.findFirst({
          select: { id: true },
          where: { isDefault: true, teamId: null },
        })
      : null;
    try {
      await prisma.workflowTemplate.create({
        data: {
          activeVersion: 1,
          description: tmpl.description,
          ...templateFields,
          isDefault: Boolean(tmpl.isDefault) && !defaultTaken,
          name: tmpl.name,
          origin: SWE_ORIGIN,
          status: 'ACTIVE',
          teamId: null,
          versions: { create: { spec, version: 1 } },
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
    }
    return;
  }

  // A description still holding the exact text an earlier release shipped was
  // never edited, so it is brought up to date; an admin's edit is never
  // overwritten. Independent of the spec comparison below.
  if ((SUPERSEDED_TEMPLATE_DESCRIPTIONS[tmpl.name] ?? []).includes(existing.description)) {
    await prisma.workflowTemplate.update({
      data: { description: tmpl.description },
      where: { id: existing.id },
    });
  }

  const versions = await prisma.workflowTemplateVersion.findMany({
    orderBy: { version: 'asc' },
    select: { createdBy: true, generatedBy: true, spec: true, version: true },
    where: { templateId: existing.id },
  });
  const builtins = versions.filter((v) => v.createdBy == null && v.generatedBy == null);
  const latestBuiltin = builtins.at(-1);
  if (latestBuiltin && canonicalJson(latestBuiltin.spec) === canonicalJson(spec)) {
    return;
  }

  const next = (versions.at(-1)?.version ?? 0) + 1;
  try {
    await prisma.workflowTemplateVersion.create({
      data: { spec, templateId: existing.id, version: next },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return;
    }
    throw err;
  }

  const onPreviousBuiltin =
    latestBuiltin !== undefined &&
    existing.activeVersion === latestBuiltin.version &&
    existing.status === 'ACTIVE';
  if (onPreviousBuiltin && (existing.experimentSplit ?? 0) > 0) {
    // A live A/B experiment compares versions by number. Moving its control arm to a
    // new version mid-experiment would split the control sample across two versions
    // (and leave a built-in experiment arm behind), so the new version is appended
    // for the admin to promote deliberately.
    console.warn(
      `[syncBuiltins] '${tmpl.name}' is running an A/B experiment (${existing.experimentSplit}% to ` +
        `v${existing.experimentVersion ?? '?'}); appended v${next} but left it on v${latestBuiltin.version}. ` +
        'Promote it when the experiment ends.'
    );
  } else if (onPreviousBuiltin) {
    // Template-level built-in fields are only filled where the row has none: the
    // admin API can PATCH them, and nothing records what the previous release
    // shipped, so a stored value cannot be told apart from an admin's edit.
    const fill = {
      ...(existing.inputSchema == null && templateFields.inputSchema
        ? { inputSchema: templateFields.inputSchema }
        : {}),
      ...(existing.workspaceProvider == null && templateFields.workspaceProvider
        ? { workspaceProvider: templateFields.workspaceProvider }
        : {}),
    };
    // Conditional on the row still pointing where we read it, so an admin's
    // concurrent activation is not overwritten.
    await prisma.workflowTemplate.updateMany({
      data: { activeVersion: next, ...fill },
      where: { activeVersion: latestBuiltin.version, id: existing.id, teamId: null },
    });
  }
}

/**
 * Returns the names of the built-in skills this call created. Content changes
 * cut a new `SkillRevision` (a no-op sync cuts none), so an in-flight run that
 * pinned the previous revision keeps its text.
 */
async function syncSkills(prisma: PrismaClient): Promise<Set<string>> {
  const created = new Set<string>();
  for (const skillDef of BUILTIN_SKILLS) {
    const content = { description: skillDef.description, promptText: skillDef.promptText };
    const existingSkill = await prisma.skill.findFirst({
      where: { isBuiltIn: true, name: skillDef.name },
    });
    if (existingSkill) {
      // isActive is intentionally omitted — preserve any admin disable decision.
      const base = { isVerified: true, origin: SWE_ORIGIN };
      if (skillContentChanged(existingSkill, content)) {
        const next = nextRevision(existingSkill, content);
        try {
          await prisma.skill.update({ data: { ...base, ...next.data }, where: next.where });
        } catch (err) {
          // Another replica booting alongside this one cut the same revision
          // from the same shipped text first; its write is the one we wanted.
          if (!isRevisionConflict(err)) {
            throw err;
          }
        }
      } else {
        await prisma.skill.update({ data: base, where: { id: existingSkill.id } });
      }
    } else {
      await prisma.skill.create({
        data: {
          ...content,
          ...initialRevision(content),
          isActive: true,
          isBuiltIn: true,
          isVerified: true,
          name: skillDef.name,
          origin: SWE_ORIGIN,
        },
      });
      created.add(skillDef.name);
    }
    // Skill→agent attachment is via the Agent's skillRefs (synced in syncAgents).
  }
  return created;
}

/**
 * Give every skill without a revision row — a custom skill created before
 * revisions existed — the row for the revision it already names, from its live
 * content. Idempotent: a skill that has any revision is untouched.
 */
async function backfillSkillRevisions(prisma: PrismaClient): Promise<void> {
  const bare = await runUnscoped(
    "startup sync backfills revision rows for every tenant's skills",
    ['Skill'],
    () => prisma.skill.findMany({ where: { revisions: { none: {} } } })
  );
  if (bare.length === 0) {
    return;
  }
  await prisma.skillRevision.createMany({
    data: bare.map((s) => ({
      contentHash: skillContentHash(s),
      description: s.description,
      promptText: s.promptText,
      revision: s.currentRevision,
      skillId: s.id,
    })),
    skipDuplicates: true,
  });
}

/**
 * Seeds the subset of built-in scanner patterns belonging to `group`:
 *   - 'core' → patterns whose origin is null (cross-cutting categories)
 *   - 'swe'  → patterns tagged 'swe-starter' (CODE_SECURITY)
 * Provenance is derived from the pattern type via `scannerPatternOrigin`.
 */
const DEFAULT_AUTONOMY_POLICY = {
  description:
    'Default platform policy: internal reads/writes are autonomous; public or mass communication requires human approval.',
  name: 'Platform default',
  rules: {
    external_communication: { action: 'require_approval' },
    internal_read: { action: 'auto' },
    internal_write: { action: 'auto' },
    mass_communication: { action: 'require_approval', approverCount: 2 },
  },
};

async function syncAutonomyPolicies(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.autonomyPolicy.findFirst({
    where: { isDefault: true, teamId: null, templateId: null },
  });
  if (existing) {
    await prisma.autonomyPolicy.update({
      data: {
        description: DEFAULT_AUTONOMY_POLICY.description,
        name: DEFAULT_AUTONOMY_POLICY.name,
        rules: DEFAULT_AUTONOMY_POLICY.rules as object,
      },
      where: { id: existing.id },
    });
  } else {
    await prisma.autonomyPolicy.create({
      data: {
        description: DEFAULT_AUTONOMY_POLICY.description,
        isDefault: true,
        name: DEFAULT_AUTONOMY_POLICY.name,
        rules: DEFAULT_AUTONOMY_POLICY.rules as object,
      },
    });
  }
}

async function syncScannerPatterns(prisma: PrismaClient, group: 'core' | 'swe'): Promise<void> {
  const wantOrigin = group === 'core' ? null : SWE_ORIGIN;
  for (const p of BUILTIN_SCANNER_PATTERNS) {
    const origin = scannerPatternOrigin(p.type);
    if (origin !== wantOrigin) {
      continue;
    }
    await prisma.scannerPattern.upsert({
      create: {
        flags: p.flags,
        isActive: true,
        isBuiltIn: true,
        label: p.label,
        origin,
        pattern: p.pattern,
        type: p.type,
      },
      // isActive intentionally omitted — preserve any admin disable decision.
      update: { flags: p.flags, origin, pattern: p.pattern, type: p.type },
      where: { label: p.label },
    });
  }
}
