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

// ── Projection onto the audit shape ──

export interface ShellNodeWithId {
  id: string;
  /** Structural subset shared by `shell` and `containerStep` — both run a
   *  team-authored image+command and are gated/audited identically. */
  node: { image: string; command: string; network?: 'none' | 'egress' };
}

// `shell`, `containerStep`, and a plain `step` node naming a `shell`-category step
// (`runContainerStep`) all execute team-authored code in a container, so they share
// the same authoring RBAC, image allowlist, and audit trail. Membership is decided by
// the shared `isContainerCodeNode`, the same predicate every worker-side draft path
// refuses on; this function only projects each node onto the image/command shape.
export function collectShellNodes(spec: WorkflowSpec): ShellNodeWithId[] {
  const out: ShellNodeWithId[] = [];
  for (const [id, node] of findContainerCodeNodes(spec)) {
    if (node.type === 'shell') {
      out.push({ id, node });
    } else if (node.type === 'containerStep') {
      out.push({
        id,
        node: { command: node.command ?? '', image: node.image, network: node.network },
      });
    } else if (node.type === 'step') {
      const cfg = node.config ?? {};
      out.push({
        id,
        node: {
          command: typeof cfg.command === 'string' ? cfg.command : '',
          // A non-string image cannot pass the allowlist; '' makes that check refuse it.
          image: typeof cfg.image === 'string' ? cfg.image : '',
          network: cfg.network === 'none' || cfg.network === 'egress' ? cfg.network : undefined,
        },
      });
    }
  }
  return out;
}

/**
 * The `image` an authored-command audit row records. An authored gate or eval command runs in
 * the run's agent workspace (the repository's executor image, chosen by the deployment), not
 * in an image the spec names, so the row says where it ran instead of naming one.
 */
export const AGENT_WORKSPACE_AUDIT_IMAGE = '(agent workspace)';

/** How an audit row spells a command the spec binds from a run-time input. */
function boundCommand(field: string, binding: unknown): string {
  return `(bound at run time: ${field} = ${JSON.stringify(binding) ?? 'undefined'})`;
}

function gateScorerCommands(scorers: unknown): string[] {
  if (!Array.isArray(scorers)) {
    return [];
  }
  return scorers.flatMap((s: unknown) => {
    const scorer = s as { kind?: unknown; command?: unknown } | null;
    return scorer?.kind === 'gate' &&
      typeof scorer.command === 'string' &&
      scorer.command.trim() !== ''
      ? [scorer.command]
      : [];
  });
}

/** The command strings one authored-command node writes into the spec (see `containerCode.ts`). */
function authoredCommandsOf(node: WorkflowSpec['nodes'][string]): string[] {
  if (node.type === 'eval') {
    return gateScorerCommands(node.scorers);
  }
  if (node.type !== 'step') {
    return [];
  }
  const config = node.config ?? {};
  const inputs = (node.inputs ?? {}) as Record<string, unknown>;
  if (isCommandGateStep(node.step)) {
    if (typeof config.command === 'string' && config.command.trim() !== '') {
      return [config.command];
    }
    return 'command' in inputs ? [boundCommand('inputs.command', inputs.command)] : [];
  }
  if (node.step === 'runQualityGates') {
    const gates = Array.isArray(config.gates) ? (config.gates as unknown[]) : [];
    const written = gates.flatMap((g) => {
      const command = (g as { command?: unknown } | null)?.command;
      return typeof command === 'string' && command.trim() !== '' ? [command] : [];
    });
    return 'gates' in inputs ? [...written, boundCommand('inputs.gates', inputs.gates)] : written;
  }
  if (node.step === 'runEvalNode') {
    return gateScorerCommands(config.scorers);
  }
  return [];
}

/**
 * Every command an author wrote into a gate step, a `runQualityGates` gate, or an eval `gate`
 * scorer, one entry per command, projected onto the audit shape. Membership is the shared
 * `isAuthoredCommandNode`; these run in the agent workspace, so the image allowlist does not
 * apply to them and they are never passed to the gateway's image check. They carry the
 * same authoring role and `WorkflowShellAudit` trail as container code.
 */
export function collectAuthoredCommandNodes(spec: WorkflowSpec): ShellNodeWithId[] {
  const out: ShellNodeWithId[] = [];
  for (const [id, node] of findAuthoredCommandNodes(spec)) {
    const commands = authoredCommandsOf(node);
    // The predicate and this projection read the same fields; a node the predicate counts
    // still yields a row if they ever disagree, so the gate cannot silently pass it.
    for (const command of commands.length > 0 ? commands : ['(authored command)']) {
      out.push({ id, node: { command, image: AGENT_WORKSPACE_AUDIT_IMAGE, network: 'egress' } });
    }
  }
  return out;
}

/**
 * The code an author wrote into a spec, split by the gates that apply to it: `shellNodes`
 * (container code) take the image allowlist; `authoredNodes` is every node that needs the
 * shell authoring role and a `WorkflowShellAudit` row — container code and authored commands.
 */
export function collectAuthoredCode(spec: WorkflowSpec): {
  shellNodes: ShellNodeWithId[];
  authoredNodes: ShellNodeWithId[];
} {
  const shellNodes = collectShellNodes(spec);
  return { authoredNodes: [...shellNodes, ...collectAuthoredCommandNodes(spec)], shellNodes };
}
