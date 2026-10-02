import { z } from 'zod';

/**
 * Agent runs: an ad-hoc "run this library Agent on this repository" launch.
 *
 * Pure, zod-only and isolate-safe, so the gateway (which validates a launch),
 * the worker (which re-validates it, because other launch paths reach the same
 * template) and the CLI share one definition of the payload, the denylist and
 * the size limits.
 */

/**
 * Name of the hidden system template behind `POST /api/v1/agent-runs`. Reserved:
 * the template create / rename routes and bundle install refuse it, because the
 * seed matches this template by name and a second row with the name would be
 * given the system spec.
 */
export const AGENT_RUN_TEMPLATE_NAME = 'Agent Run';

/**
 * Value of the dedicated `WorkflowTemplate.origin` marker on the system
 * template. NOT `'swe-starter'` (deployment-owned content an admin may edit) and
 * not a bundle `source`: the bundle installer treats any other non-null origin
 * as bundle-owned and appends versions to it, so a bundle must be refused both
 * the name and any `system:` origin (see `isReservedTemplateOrigin`).
 */
export const AGENT_RUN_TEMPLATE_ORIGIN = 'system:agent-run';

/** The internal step that owns the workspace, gate and push. System template only. */
export const AGENT_RUN_STEP = 'runAgentTask';

/** Case-insensitive: the seed matches by name and a near-miss must not slip through. */
export function isReservedTemplateName(name: string): boolean {
  return name.trim().toLowerCase() === AGENT_RUN_TEMPLATE_NAME.toLowerCase();
}

/** `true` for an origin no bundle or API write may set. */
export function isReservedTemplateOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && origin.startsWith('system:');
}

export const AGENT_RUN_DELIVERIES = ['none', 'branch', 'draft_pr'] as const;
export type AgentRunDelivery = (typeof AGENT_RUN_DELIVERIES)[number];

/**
 * Agent keys that must never be launched as an agent run. They back platform
 * mechanisms with their own contract (the security gate, the eval judge, memory
 * and workflow authoring) and a user steering one with free text is either a
 * way to talk the gate into passing or a way to reach a capability they were
 * never given. A code list rather than an `Agent` column: adding the column
 * needs a migration, and admins already curate which agents exist.
 */
export const NON_LAUNCHABLE_AGENT_KEYS: ReadonlySet<string> = new Set([
  'securityReview',
  'evalJudge',
  'commitToMemory',
  'validateContext',
  'lessonConsolidator',
  'workflowAuthor',
  'workflowExplainer',
  'repoDependencyInferrer',
  'channelAssistant',
]);

export function isLaunchableAgentKey(key: string): boolean {
  return !NON_LAUNCHABLE_AGENT_KEYS.has(key);
}

/** `<key>` or `<key>@<version>`, the grammar `parseAgentRef` accepts. */
export const AGENT_REF_RE = /^[A-Za-z0-9_.-]+(@[1-9][0-9]*)?$/;

/**
 * What the gateway writes to `RunInput.payload` and the system template reads
 * with `request.payload.*`. The worker parses it again with this same schema:
 * the template is reachable from other launch paths (`/workflow-templates/:id/runs`,
 * Slack, schedules, webhooks, bundles), so nothing the gateway checked may be
 * assumed.
 */
export const AgentRunPayloadSchema = z.object({
  agentRef: z.string().min(1).max(130).regex(AGENT_REF_RE),
  deliver: z.enum(AGENT_RUN_DELIVERIES).default('none'),
  /** Per-launch caps. Can only lower the platform ceilings. */
  maxSteps: z.number().int().min(1).max(500).optional(),
  maxWallClockSeconds: z.number().int().min(60).max(14_400).optional(),
});
export type AgentRunPayload = z.infer<typeof AgentRunPayloadSchema>;

/** `min(requested ?? ceiling, ceiling)`: a launch can only lower a ceiling. */
export function clampToCeiling(requested: number | undefined, ceiling: number): number {
  return Math.min(requested ?? ceiling, ceiling);
}

/**
 * Synthetic ticket id for a run that has no ticket: `agent-<32 hex>`, the whole
 * UUID. A truncated id collides at tens of thousands of runs, and a branch
 * collision fails the non-force push after the full spend.
 */
export function agentRunTicketId(workRequestId: string): string {
  return `agent-${workRequestId.replace(/-/g, '').slice(0, 32)}`;
}

/**
 * Size limits. A diff rides in the activity result, in the step output and in
 * the terminate result, and Temporal rejects any payload over 2 MB, so a diff
 * large enough to fail the completion after the push would leave a pushed
 * branch and a FAILED run. Three copies of the returned diff stay well under
 * 2 MB at this cap even at 3 bytes per character.
 */
/** Longest launch prompt. It travels as the work request's description, which has the same bound. */
export const AGENT_RUN_MAX_PROMPT_CHARS = 20_000;
export const AGENT_RUN_MAX_OUTPUT_DIFF_CHARS = 100_000;
/** A delivered change whose diff exceeds this cannot be gated and is refused. */
export const AGENT_RUN_MAX_GATED_DIFF_CHARS = 300_000;
/** Longest agent text kept in the run output. */
export const AGENT_RUN_MAX_TEXT_CHARS = 20_000;
/** Most changed files a delivered run may publish. */
/**
 * Hard upper bound of `workspace.agentRunMaxWallClockSeconds` (4 h). The
 * workflow's activity timeout is derived from it
 * (`workflows/proxyOptions.ts` `T_AGENT_RUN_ACTIVITY_SECONDS`, which cannot
 * import this value because workflow code runs in an isolate; a test pins the two).
 */
export const AGENT_RUN_MAX_WALL_CLOCK_SECONDS = 14_400;
export const AGENT_RUN_MAX_CHANGED_FILES = 500;
/** Largest single changed file a delivered run may publish. */
export const AGENT_RUN_MAX_FILE_BYTES = 1_000_000;

/**
 * `WorkflowSpec` of the system template: one internal step, then terminate. The
 * workspace, the gate and the push all live inside `runAgentTask`, so there is no
 * node an author could remove, reorder or route around. Typed loosely (object
 * literal) like the channel templates, and parsed wherever it is consumed.
 */
export const AGENT_RUN_SPEC = {
  description:
    'System template behind POST /api/v1/agent-runs: runs one library agent against one repository in a throwaway workspace and optionally publishes the result. Not editable.',
  entry: 'run',
  name: AGENT_RUN_TEMPLATE_NAME,
  nodes: {
    done: {
      result: {
        baseSha: { from: 'nodes.run.output.baseSha' },
        branch: { from: 'nodes.run.output.branch' },
        deliver: { from: 'nodes.run.output.deliver' },
        diff: { from: 'nodes.run.output.diff' },
        diffTruncated: { from: 'nodes.run.output.diffTruncated' },
        diffVerified: { from: 'nodes.run.output.diffVerified' },
        filesChanged: { from: 'nodes.run.output.filesChanged' },
        gate: { from: 'nodes.run.output.gate' },
        headSha: { from: 'nodes.run.output.headSha' },
        prNumber: { from: 'nodes.run.output.prNumber' },
        prUrl: { from: 'nodes.run.output.prUrl' },
        stoppedReason: { from: 'nodes.run.output.stoppedReason' },
        text: { from: 'nodes.run.output.text' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    run: {
      inputs: { task: { from: 'request.description' } },
      next: 'done',
      spanName: 'llm.agent_run',
      step: AGENT_RUN_STEP,
      type: 'step',
    },
  },
  schemaVersion: 1,
} as const;
