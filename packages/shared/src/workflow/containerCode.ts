/**
 * Spec predicates for nodes that run code an author wrote, for the gates that must not let such
 * code through a path with no authorization or audit.
 *
 * Two predicates, covering two different things:
 *
 * - **Container code** ({@link isContainerCodeNode}): a node that runs a team-authored image and
 *   command in the shell sandbox (an ephemeral container under the image allowlist and network
 *   policy). Three spellings reach the same executor: a `shell` node, a `containerStep` node,
 *   and a plain `step` node naming a registered step whose category is `shell`
 *   (`runContainerStep`). The `step` spelling is reachable by hand-written or generated JSON and
 *   the interpreter dispatches it exactly like the declarative node, so a gate that checks node
 *   `type` alone leaves it ungated. The gateway's save-time shell gates (authoring role, image
 *   allowlist, `WorkflowShellAudit`) and every worker-side refusal ask this predicate.
 *
 * - **Authored commands** ({@link isAuthoredCommandNode}): a node that runs a command string
 *   written into the spec, in the run's agent workspace rather than the shell sandbox:
 *   - a `step` node naming a `gate` step that takes a `command` (`runLint`, `runTypecheck`,
 *     `runTests`, `runBuild`, `runVulnScan`, `runPerfBench`) with a non-blank `config.command`,
 *     or with any `inputs.command` binding (its value is only known at run time, so its
 *     presence counts);
 *   - a `runQualityGates` step whose `config.gates` has an entry with a non-blank `command`, or
 *     with any `inputs.gates` binding;
 *   - an `eval` node, or a `step` node naming `runEvalNode`, with a `gate` scorer carrying a
 *     non-blank `command`.
 *   A gate with no command runs the repository's own command (`Repository.gateCommands`) or the
 *   built-in default, which the spec did not write, so it does not count.
 *
 * The gateway's save, review, promote and activate paths require the shell authoring role and
 * write `WorkflowShellAudit` rows for both kinds (only container code takes the image
 * allowlist). The worker-side paths that are never shell-authorized — the async and channel
 * generation paths and channel refinement — refuse both, through this module.
 *
 * Limitation: an authored command runs in the agent workspace without the shell sandbox; the
 * role and the audit row are its only controls.
 */

import type { Node, WorkflowSpec } from './spec.js';
import { getStepMetadata, hasStep } from './stepRegistry.js';

/** True when `name` is a registered step in the `shell` category (`runContainerStep`). */
export function isShellCategoryStep(name: string): boolean {
  return hasStep(name) && getStepMetadata(name).category === 'shell';
}

/** True when the node executes team-authored code in a container, in any spelling. */
export function isContainerCodeNode(node: Node): boolean {
  if (node.type === 'shell' || node.type === 'containerStep') {
    return true;
  }
  return node.type === 'step' && isShellCategoryStep(node.step);
}

/** The `[id, node]` pairs of every node in the spec that runs container code. */
export function findContainerCodeNodes(spec: WorkflowSpec): Array<[string, Node]> {
  return Object.entries(spec.nodes).filter(([, node]) => isContainerCodeNode(node));
}

/** Whether the spec contains any node that runs container code. */
export function hasContainerCodeNode(spec: WorkflowSpec): boolean {
  return Object.values(spec.nodes).some(isContainerCodeNode);
}

/** The batch gate step: its commands live per gate, in `gates[].command`. */
const QUALITY_GATES_STEP = 'runQualityGates';
/** The executor behind the `eval` node: its scorers live in `config.scorers`. */
const EVAL_NODE_STEP = 'runEvalNode';

function isNonBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function hasNonBlankCommand(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    isNonBlankString((value as { command?: unknown }).command)
  );
}

function hasAuthoredGateScorer(scorers: unknown): boolean {
  return (
    Array.isArray(scorers) &&
    scorers.some((s) => hasNonBlankCommand(s) && (s as { kind?: unknown }).kind === 'gate')
  );
}

/** True when `name` is a registered `gate` step that takes one `command` (`runLint`, …). */
export function isCommandGateStep(name: string): boolean {
  if (!hasStep(name)) {
    return false;
  }
  const meta = getStepMetadata(name);
  return meta.category === 'gate' && meta.configFields.some((f) => f.key === 'command');
}

/** True when the node runs a command string written into the spec (see the module comment). */
export function isAuthoredCommandNode(node: Node): boolean {
  if (node.type === 'eval') {
    return hasAuthoredGateScorer(node.scorers);
  }
  if (node.type !== 'step') {
    return false;
  }
  const config = node.config ?? {};
  const inputs = node.inputs ?? {};
  if (isCommandGateStep(node.step)) {
    return isNonBlankString(config.command) || 'command' in inputs;
  }
  if (node.step === QUALITY_GATES_STEP) {
    return (
      'gates' in inputs || (Array.isArray(config.gates) && config.gates.some(hasNonBlankCommand))
    );
  }
  if (node.step === EVAL_NODE_STEP) {
    return hasAuthoredGateScorer(config.scorers);
  }
  return false;
}

/** The `[id, node]` pairs of every node in the spec that runs an authored command. */
export function findAuthoredCommandNodes(spec: WorkflowSpec): Array<[string, Node]> {
  return Object.entries(spec.nodes).filter(([, node]) => isAuthoredCommandNode(node));
}

/** Whether the spec contains any node that runs an authored command. */
export function hasAuthoredCommand(spec: WorkflowSpec): boolean {
  return Object.values(spec.nodes).some(isAuthoredCommandNode);
}

/**
 * Whether the spec runs any code an author wrote — container code or an authored command. The
 * refusal the never-shell-authorized worker paths apply.
 */
export function hasAuthoredCode(spec: WorkflowSpec): boolean {
  return hasContainerCodeNode(spec) || hasAuthoredCommand(spec);
}
