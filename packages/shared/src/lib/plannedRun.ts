import { z } from 'zod';

/**
 * Planned runs: a run started from an approved `RunPlan` (docs/specs/2026-11-17-launch-time-workflow-generation.md).
 *
 * Pure and zod-only, like `agentRun.ts`, so the gateway (which launches one), the worker (which
 * pins the plan's spec when the run is created) and the tests share one definition of the
 * template's identity and its launch payload.
 */

/**
 * Name of the hidden system template every planned run executes under. Reserved the same way
 * `AGENT_RUN_TEMPLATE_NAME` is: the template create / rename routes and bundle install refuse it,
 * because the seed matches the template by name.
 */
export const PLANNED_RUN_TEMPLATE_NAME = 'Planned Run';

/**
 * Value of `WorkflowTemplate.origin` on the Planned Run template. A `system:` origin, so every
 * guard that hides the Agent Run template (`isSystemTemplate`, `EXCLUDE_SYSTEM_TEMPLATES`, the
 * bundle installer's reserved-origin refusal) hides this one too, with no per-template code.
 */
export const PLANNED_RUN_TEMPLATE_ORIGIN = 'system:planned-run';

/** `true` for the Planned Run template: the reserved origin on a template with no owning team. */
export function isPlannedRunTemplate(t: {
  origin?: string | null;
  teamId?: string | null;
  team?: unknown | null;
}): boolean {
  const global = t.teamId === undefined ? t.team == null : t.teamId === null;
  return global && t.origin === PLANNED_RUN_TEMPLATE_ORIGIN;
}

/** What the gateway writes to `RunInput.payload`: only the plan's id. The worker parses it again. */
export const PlannedRunPayloadSchema = z.object({ planId: z.string().uuid() }).strict();
export type PlannedRunPayload = z.infer<typeof PlannedRunPayloadSchema>;

/** The two modes of a plan (`RunPlan.mode`, enforced by a CHECK constraint). */
export const RUN_PLAN_MODES = ['delivering', 'output-only'] as const;
export type RunPlanMode = (typeof RUN_PLAN_MODES)[number];

/**
 * Synthetic ticket id of a planned run: `plan-<32 hex>`, the whole plan id. A planned run has no
 * tracker ticket, and the pushed branch (`<prefix>/plan-<hex>`) must not collide with another run.
 */
export function plannedRunTicketId(planId: string): string {
  return `plan-${planId.replace(/-/g, '').slice(0, 32)}`;
}

/**
 * `WorkflowSpec` of the system template: ONE terminate node that fails. It is a placeholder and is
 * never executed on purpose: `createWorkflowRun` replaces it with the approved plan's spec before
 * the run exists. If that replacement were ever skipped, the run ends FAILED instead of doing
 * anything, so a bug in the pin cannot turn the template into a way to run something else.
 */
export const PLANNED_RUN_SPEC = {
  description:
    "System template behind approved run plans. The worker pins the plan's own spec when the run is created; this placeholder fails if it is ever run as it stands. Not editable.",
  entry: 'placeholder',
  name: PLANNED_RUN_TEMPLATE_NAME,
  nodes: {
    placeholder: {
      result: { reason: { literal: 'planned-run-spec-not-pinned' } },
      status: 'FAILED',
      type: 'terminate',
    },
  },
  schemaVersion: 1,
} as const;

/** The key of an `agentRef` (`<key>` or `<key>@<version>`). */
function agentRefKey(ref: string): string {
  const at = ref.lastIndexOf('@');
  return at === -1 ? ref : ref.slice(0, at);
}

/**
 * Whether a plan's mode, its library agent and its spec agree, as a reason when they do not.
 *
 * `output-only` is exactly the library-agent plan: it names the agent it is built on, and the spec
 * has an `agent` node running it. A `delivering` plan is the implementer path and names none.
 * Admission (agent-run concurrency) is keyed on the mode, so a plan whose mode and agent disagree
 * could otherwise take the engineering path's lack of limits while carrying an agent, or the
 * reverse. Checked at creation, at approval, at launch (mode and key only) and by the worker.
 */
export function runPlanConsistencyIssue(
  plan: { mode: string; agentKey: string | null | undefined },
  spec?: { nodes?: Record<string, unknown> }
): string | null {
  if (plan.mode === 'delivering') {
    return plan.agentKey ? 'a delivering plan is not built on a library agent' : null;
  }
  if (plan.mode !== 'output-only') {
    return 'unknown plan mode';
  }
  if (!plan.agentKey) {
    return 'an output-only plan must name the library agent it is built on';
  }
  if (spec) {
    const runsIt = Object.values(spec.nodes ?? {}).some((node) => {
      const n = node as { type?: unknown; agentRef?: unknown };
      return (
        n.type === 'agent' &&
        typeof n.agentRef === 'string' &&
        agentRefKey(n.agentRef) === plan.agentKey
      );
    });
    if (!runsIt) {
      return `the plan names agent '${plan.agentKey}' but no agent node of the spec runs it`;
    }
  }
  return null;
}
