import { detectedGateDefaults, YARN_GATE_DEFAULTS } from '@auto-swe/shared/lib/stackDetection';
import type { GateName } from './qualityGates.js';

/**
 * The built-in command for each gate, the last resort of {@link gateCommandFor}. They are `yarn`
 * commands, so they belong to a Node root on Yarn (or one with no detection); another stack's
 * default comes from its detection first.
 */
export const DEFAULT_COMMANDS: Record<GateName, string | null> = {
  ...YARN_GATE_DEFAULTS,
  // runPerfBench has no sensible default: the operator supplies one.
  runPerfBench: null,
};

/**
 * The command a gate runs, most specific first: the step's `command`, the repository's
 * `gateCommands`, the default for the stack its root was detected as, then the built-in.
 * Null when none applies, which the caller reports as a FAILED gate (`noCommandResult`): a
 * gate that cannot run has not verified anything, and its node's `onFail: 'warn'` is the
 * supported way to make it optional. `runPerfBench` has no built-in, and a gate a detected
 * non-Node stack has no command for is null too — never another ecosystem's command.
 *
 * Whitespace-only counts as absent at every level: a command that runs nothing must not read
 * as a gate that ran and passed.
 */
export function gateCommandFor(
  gate: GateName,
  override: string | null | undefined,
  repo: { detectedStack?: unknown; gateCommands?: unknown }
): string | null {
  if (override && override.trim().length > 0) {
    return override;
  }
  const repoOverrides = (repo.gateCommands ?? null) as Record<string, unknown> | null;
  const configured = repoOverrides?.[gate];
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured;
  }
  // A non-Node root gets its stack's command or none: running a `yarn` one in a Python
  // or JVM workspace exits 127 and reads as broken code.
  const stackDefaults = detectedGateDefaults(repo.detectedStack);
  if (stackDefaults) {
    return stackDefaults[gate] ?? null;
  }
  return DEFAULT_COMMANDS[gate];
}
