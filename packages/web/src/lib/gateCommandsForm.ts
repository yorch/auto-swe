import {
  REPO_GATE_COMMAND_KEYS,
  type RepoGateCommandKey,
  type RepoGateCommands,
} from '@auto-swe/shared/types/api';

/** What the connection form calls each gate a repository may give its own command. */
export const GATE_COMMAND_LABELS: Record<RepoGateCommandKey, string> = {
  runBuild: 'Build',
  runLint: 'Lint',
  runPerfBench: 'Performance benchmark',
  runTests: 'Tests',
  runTypecheck: 'Typecheck',
  runVulnScan: 'Vulnerability scan',
};

/** Who may change a repository's gate commands, as the gateway's `gateCommandsProblem` decides. */
export const GATE_COMMANDS_RULE =
  "These commands run in the workspace of every run on this repository, so changing them needs a platform admin or an admin of the repository's team.";

/** The form's state: one string per gate, blank for a gate the repository does not override. */
export type GateCommandsForm = Record<RepoGateCommandKey, string>;

export function gateCommandsForm(stored: RepoGateCommands | null | undefined): GateCommandsForm {
  return Object.fromEntries(
    REPO_GATE_COMMAND_KEYS.map((key) => [key, stored?.[key] ?? ''])
  ) as GateCommandsForm;
}

function normalise(form: GateCommandsForm): RepoGateCommands | null {
  const out: RepoGateCommands = {};
  for (const key of REPO_GATE_COMMAND_KEYS) {
    if (form[key].trim() !== '') {
      out[key] = form[key];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The `gateCommands` a PATCH should carry: `undefined` when the form still holds the stored set, so
 * an edit to the rest of the repository by someone who may not change them is never refused for
 * them; otherwise the full replacement set, or null to clear every override.
 */
export function gateCommandsPatch(
  stored: RepoGateCommands | null | undefined,
  form: GateCommandsForm
): RepoGateCommands | null | undefined {
  const next = normalise(form);
  const same = REPO_GATE_COMMAND_KEYS.every(
    (key) => (next?.[key] ?? null) === (normalise(gateCommandsForm(stored))?.[key] ?? null)
  );
  return same ? undefined : next;
}
