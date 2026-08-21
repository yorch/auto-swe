import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_SCANNER_PATTERNS, scannerPatternOrigin } from '../scannerPatterns/index.js';
import { BUILTIN_SKILLS } from '../skills/index.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import {
  CHANNEL_ASSISTANT_PROMPT,
  CI_FIX_SYSTEM_PROMPT,
  CONTEXT_VALIDATOR_PROMPT,
  DECOMPOSER_AGENT_PROMPT,
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  GATE_FIX_SYSTEM_PROMPT,
  IMPLEMENTER_SYSTEM_PROMPT,
  LESSON_CONSOLIDATOR_PROMPT,
  MEMORY_SUMMARIZER_PROMPT,
  MERGE_CONFLICT_RESOLVER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  PLANNER_AGENT_PROMPT,
  PRD_ANALYST_PROMPT,
  PRD_DECOMPOSER_PROMPT,
  REVIEW_FIX_SYSTEM_PROMPT,
  SECURITY_AUDITOR_PROMPT,
  SECURITY_REVIEW_PROMPT,
  WORKFLOW_AUTHOR_PROMPT,
  WORKFLOW_EXPLAINER_PROMPT,
} from './agentPrompts.js';
import { CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_TASK_TEMPLATE_NAME } from './channelTask.js';

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
export { CHANNEL_ASSISTANT_TEMPLATE_NAME, CHANNEL_TASK_TEMPLATE_NAME } from './channelTask.js';

/**
 * Minimal valid `WorkflowSpec` for the Channel Assistant template: a single
 * terminal node. The `/runs` trace viewer renders the AgentTrace event stream
 * regardless of node mapping, so a richer graph would be dead weight here.
 *
 * Typed loosely (object literal) so this file doesn't depend on the workflow spec
 * package; it is parsed/validated wherever it's consumed.
 */
export const CHANNEL_ASSISTANT_SPEC = {
  description:
    'Observability shell for channel-assistant turns and ambient digests. ' +
    'Not interpreted — a lightweight run is created per channel turn so its ' +
    'agent traces (LLM calls) are visible in the run viewer.',
  entry: 'done',
  name: CHANNEL_ASSISTANT_TEMPLATE_NAME,
  nodes: {
    done: { status: 'SUCCESS', type: 'terminate' },
  },
  schemaVersion: 1,
} as const;

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
 * Behavior is identical to before — everything is still seeded — it is just
 * grouped and provenance-tagged. Safe to call on every startup (findFirst +
 * conditional create/update; scanner patterns upsert by the `label` unique index).
 */
export async function syncBuiltins(prisma: PrismaClient): Promise<void> {
  await seedCoreDefaults(prisma);
  await seedSweStarter(prisma);
}

/** Core platform defaults (origin=null). Always seeded. */
export async function seedCoreDefaults(prisma: PrismaClient): Promise<void> {
  await syncScannerPatterns(prisma, 'core');
}

/** SWE starter content (origin='swe-starter'). Opt-out-able in the future. */
export async function seedSweStarter(prisma: PrismaClient): Promise<void> {
  await syncTemplates(prisma);
  await syncChannelAssistantTemplate(prisma);
  await syncChannelTaskTemplate(prisma);
  await syncSkills(prisma);
  await syncScannerPatterns(prisma, 'swe');
  await syncAgents(prisma);
  await syncEvalRubrics(prisma);
}

/**
 * Seed a GLOBAL, single-version channel template (the "Channel Assistant"
 * observability shell or the "Channel Task" autonomous-execution substrate) + its
 * v1 spec. Idempotent: matches the existing row by `(name, teamId=null)` and
 * upserts the version, exactly like {@link syncTemplates}. Active so it never
 * trips template-status gates. Both rows are distinct from the SWE templates in
 * `BUILTIN_TEMPLATES` on purpose — never offered as a run-on-submit option, so
 * not worth carrying through the BuiltinTemplate machinery.
 */
async function syncGlobalChannelTemplate(
  prisma: PrismaClient,
  name: string,
  spec: { description: string }
): Promise<void> {
  const existing = await prisma.workflowTemplate.findFirst({
    where: { name, teamId: null },
  });
  const t = existing
    ? await prisma.workflowTemplate.update({
        data: { activeVersion: 1, isDefault: false, origin: SWE_ORIGIN, status: 'ACTIVE' },
        where: { id: existing.id },
      })
    : await prisma.workflowTemplate.create({
        data: {
          activeVersion: 1,
          description: spec.description,
          isDefault: false,
          name,
          origin: SWE_ORIGIN,
          status: 'ACTIVE',
          teamId: null,
        },
      });
  await prisma.workflowTemplateVersion.upsert({
    create: { spec: spec as unknown as object, templateId: t.id, version: 1 },
    update: { spec: spec as unknown as object },
    where: { templateId_version: { templateId: t.id, version: 1 } },
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
interface SweAgentDef {
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

const SWE_AGENTS: ReadonlyArray<SweAgentDef> = [
  {
    description: 'Writes code in the workspace via the TDD loop.',
    key: 'implementer',
    modelSpec: 'anthropic/claude-opus-4-8',
    name: 'Implementer',
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    toolKeys: IMPLEMENTER_TOOLS,
  },
  {
    description: 'Reviews diffs through the multi-agent review network.',
    key: 'reviewer',
    modelSpec: 'anthropic/claude-opus-4-8',
    name: 'Reviewer',
    systemPrompt: DOMAIN_LOGIC_REVIEWER_PROMPT,
  },
  {
    description: 'Decomposes work into an implementation plan.',
    key: 'planner',
    modelSpec: 'anthropic/claude-sonnet-4-6',
    name: 'Planner',
    systemPrompt: PLANNER_AGENT_PROMPT,
  },
  {
    description: 'Post-diff security gate — CRITICAL findings fail the activity.',
    key: 'securityReview',
    modelSpec: 'anthropic/claude-sonnet-4-6',
    name: 'Security Review',
    systemPrompt: SECURITY_REVIEW_PROMPT,
  },
  {
    description: 'Extracts success criteria from the work request.',
    key: 'validateContext',
    modelSpec: 'anthropic/claude-sonnet-4-6',
    name: 'Context Validator',
    systemPrompt: CONTEXT_VALIDATOR_PROMPT,
  },
  {
    description: 'Commits lessons to semantic memory.',
    key: 'commitToMemory',
    modelSpec: 'anthropic/claude-opus-4-8',
    name: 'Memory Committer',
    systemPrompt: MEMORY_SUMMARIZER_PROMPT,
  },
  {
    // Channel assistant (Phase 0): the shared, per-channel Slack assistant. Model-backed
    // so each channel can resolve its own model via the CHANNEL config tier; the
    // GLOBAL row seeded here is the default the cascade falls back to.
    description: 'Shared per-channel Slack teammate that answers @mentions in-thread.',
    key: 'channelAssistant',
    modelSpec: 'anthropic/claude-opus-4-8',
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
    modelSpec: 'anthropic/claude-opus-4-8',
    name: 'Workflow Author',
    systemPrompt: WORKFLOW_AUTHOR_PROMPT,
  },
  {
    // Inverse of workflowAuthor: summarizes an existing spec in plain language.
    // A cheaper model is plenty for read-and-describe; resolved on demand (not
    // in MODEL_BACKED_AGENT_KEYS, so it never gates worker boot).
    description: 'Explains an existing WorkflowSpec in plain language.',
    key: 'workflowExplainer',
    modelSpec: 'anthropic/claude-sonnet-4-6',
    name: 'Workflow Explainer',
    systemPrompt: WORKFLOW_EXPLAINER_PROMPT,
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

async function syncAgents(prisma: PrismaClient): Promise<void> {
  const skillMap = skillsByAgentKey();
  for (const def of SWE_AGENTS) {
    let agent = await prisma.agent.findFirst({
      where: { key: def.key, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
    });
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
    } else if (!agent.systemPrompt) {
      // One-time migration: backfill systemPrompt for existing rows that predate
      // this change. Skipped once an admin has set a custom value.
      await prisma.agent.update({
        data: { systemPrompt: def.systemPrompt },
        where: { id: agent.id },
      });
    }

    // Sync the agent's skill refs from the built-in assignments (idempotent).
    for (const want of skillMap.get(def.key) ?? []) {
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

async function syncTemplates(prisma: PrismaClient): Promise<void> {
  for (const tmpl of BUILTIN_TEMPLATES) {
    const existing = await prisma.workflowTemplate.findFirst({
      where: { name: tmpl.name, teamId: null },
    });
    const t = existing
      ? await prisma.workflowTemplate.update({
          data: {
            activeVersion: 1,
            ...(tmpl.inputSchema ? { inputSchema: tmpl.inputSchema as object } : {}),
            isDefault: tmpl.isDefault ?? false,
            origin: SWE_ORIGIN,
            status: 'ACTIVE',
          },
          where: { id: existing.id },
        })
      : await prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            description: tmpl.description,
            ...(tmpl.inputSchema ? { inputSchema: tmpl.inputSchema as object } : {}),
            isDefault: tmpl.isDefault ?? false,
            name: tmpl.name,
            origin: SWE_ORIGIN,
            status: 'ACTIVE',
            teamId: null,
          },
        });
    await prisma.workflowTemplateVersion.upsert({
      create: { spec: tmpl.spec as unknown as object, templateId: t.id, version: 1 },
      update: { spec: tmpl.spec as unknown as object },
      where: { templateId_version: { templateId: t.id, version: 1 } },
    });
  }
}

async function syncSkills(prisma: PrismaClient): Promise<void> {
  for (const skillDef of BUILTIN_SKILLS) {
    const existingSkill = await prisma.skill.findFirst({
      where: { isBuiltIn: true, name: skillDef.name },
    });
    if (existingSkill) {
      // isActive is intentionally omitted — preserve any admin disable decision.
      await prisma.skill.update({
        data: {
          description: skillDef.description,
          isVerified: true,
          origin: SWE_ORIGIN,
          promptText: skillDef.promptText,
        },
        where: { id: existingSkill.id },
      });
    } else {
      await prisma.skill.create({
        data: {
          description: skillDef.description,
          isActive: true,
          isBuiltIn: true,
          isVerified: true,
          name: skillDef.name,
          origin: SWE_ORIGIN,
          promptText: skillDef.promptText,
        },
      });
    }
    // Skill→agent attachment is via the Agent's skillRefs (synced in syncAgents);
    // the legacy AgentSkillAssignment table was removed in P1.5.
  }
}

/**
 * Seeds the subset of built-in scanner patterns belonging to `group`:
 *   - 'core' → patterns whose origin is null (cross-cutting categories)
 *   - 'swe'  → patterns tagged 'swe-starter' (CODE_SECURITY)
 * Provenance is derived from the pattern type via `scannerPatternOrigin`.
 */
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
