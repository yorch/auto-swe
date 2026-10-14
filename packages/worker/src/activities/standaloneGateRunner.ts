/**
 * Standalone gate runner — P1 of the evals feature (docs/evals-p1.md).
 *
 * Runs a quality gate against an arbitrary repo/commit *outside* a workflow, so
 * the offline harness can use the existing execution gates as scorers over a
 * frozen-benchmark fixture. Mirrors `runGate`'s workspace lifecycle but drops
 * the `RepoWorkRequest`/Temporal coupling — it takes an authed clone URL + an
 * optional pinned SHA directly.
 */

import { DEFAULT_COMMANDS, type GateName, type GateResult } from './qualityGates.js';
import { createWorkspace } from './workspace.js';

export interface StandaloneGateInput {
  authedRepoUrl: string;
  branch: string;
  defaultBranch: string;
  /** Pin the fixture to an exact commit (frozen-benchmark determinism). */
  checkoutSha?: string;
  /**
   * When true, `branch` is an existing remote branch to check out directly (the
   * node-level eval-gate path) rather than a new branch cut from defaultBranch.
   */
  existingBranch?: boolean;
  gate: GateName;
  /** Command override; falls back to the gate's built-in default. */
  command?: string;
  image?: string;
  timeoutMs?: number;
}

/**
 * Provision a workspace (optionally at a pinned SHA), run the gate command,
 * capture the result, and tear the workspace down. Never throws on a non-zero
 * exit — returns `{ passed: false }`, like `runGate`.
 */
export async function runGateStandalone(input: StandaloneGateInput): Promise<GateResult> {
  const command = input.command ?? DEFAULT_COMMANDS[input.gate];
  if (!command) {
    return {
      exitCode: 0,
      passed: true,
      summary: `${input.gate}: no command configured; treating as no-op`,
    };
  }

  const workspace = await createWorkspace(
    input.authedRepoUrl,
    input.branch,
    input.defaultBranch,
    input.image,
    input.checkoutSha,
    input.existingBranch
  );
  try {
    const result = await workspace.execCapture(command, { timeoutMs: input.timeoutMs });
    const passed = result.exitCode === 0 && !result.signal;
    return {
      exitCode: result.exitCode,
      passed,
      ...(result.signal ? { signal: result.signal } : {}),
      summary: passed
        ? `${input.gate} passed (exit 0)`
        : `${input.gate} failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''})`,
    };
  } finally {
    await workspace.destroy();
  }
}
