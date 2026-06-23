/**
 * Quality-gate activities — phase 2 of the configurable workflow engine.
 *
 * Each gate executes a configurable shell command inside the work-request's
 * Docker workspace, captures stdout+stderr+exitCode without throwing, stores
 * the full output as a WorkflowArtifact, and returns a small
 * `{ passed, summary, artifactId?, exitCode }` payload that the interpreter
 * uses to honor the step's `onFail` policy.
 *
 * The activities here intentionally do not throw on non-zero exits; the
 * interpreter translates `passed: false` into the configured failure mode
 * (block / warn / retry) per docs/configurable-workflows.md phase 2.
 *
 * Command resolution order (highest precedence first):
 *   1. `config.command` on the step node (template-author override)
 *   2. `Connection.gateCommands[step]` (git_repo connection override)
 *   3. Built-in default in `DEFAULT_COMMANDS` below
 *
 * The first match always wins; we never silently merge.
 */

import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { GATE_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import { currentWorkflowRunId } from '../lib/activityContext.js';
import { putArtifact } from '../lib/artifactStore.js';
import { recordGateEval } from '../lib/evalCapture.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { runImplementerFixSession } from './implementerSession.js';
import { createWorkspace, shellQuote, type Workspace } from './workspace.js';

export type GateName =
  | 'runLint'
  | 'runTypecheck'
  | 'runTests'
  | 'runBuild'
  | 'runVulnScan'
  | 'runPerfBench';

export interface GateInput {
  request: RepoWorkRequest;
  /** Step-level command override (highest precedence). */
  command?: string;
  /** Max wall-clock for the gate run in milliseconds (default 10 min). */
  timeoutMs?: number;
  /**
   * Phase-8: optional branch override. Default is `<BRANCH_PREFIX>/<ticketId>`.
   * Per-branch fan-out specs bind this to the subtask branch so each gate
   * runs against the implementer's per-branch tree, not the parent feature
   * branch.
   */
  branch?: string;
}

export interface GateResult {
  passed: boolean;
  summary: string;
  /** Reference into WorkflowArtifact; full stdout+stderr lives there. */
  artifactId?: string;
  exitCode: number;
  /** Optional shell signal if the run was killed (e.g. timeout). */
  signal?: string;
}

export const DEFAULT_COMMANDS: Record<GateName, string | null> = {
  runBuild: 'yarn build',
  runLint: 'yarn lint',
  // runPerfBench has no sensible default — operators must supply one or skip the step.
  runPerfBench: null,
  runTests: 'yarn test',
  runTypecheck: 'yarn typecheck',
  runVulnScan: 'yarn npm audit --severity high',
};

const ARTIFACT_KIND: Record<GateName, string> = {
  runBuild: 'gate.build',
  runLint: 'gate.lint',
  runPerfBench: 'gate.perf',
  runTests: 'gate.tests',
  runTypecheck: 'gate.typecheck',
  runVulnScan: 'gate.vuln',
};

/** Truncate to N bytes (UTF-8) with a marker. Used for inline summaries that
 *  must fit the 4KB metadata cap on workflow_steps. We slice on character
 *  boundaries (Buffer.from + decode) so we never split a multi-byte sequence
 *  mid-codepoint.
 */
export function truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return s;
  }
  const half = Math.floor(maxBytes / 2);
  // Decoding ignores invalid trailing bytes from a mid-codepoint cut, so a
  // worst-case 3-byte loss is acceptable here.
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.byteLength - half).toString('utf8');
  return `${head}\n…[truncated ${buf.byteLength - maxBytes} bytes]…\n${tail}`;
}

/**
 * Resolve gate command from step config → repo override → default. Returns
 * null when no command is configured anywhere; the caller should report this
 * as a non-failure SKIP via `passed: true` so the spec can decide policy.
 */
export async function resolveCommand(
  gate: GateName,
  request: RepoWorkRequest,
  override: string | undefined
): Promise<string | null> {
  if (override && override.trim().length > 0) {
    return override;
  }

  const repo = await prisma.connection.findUniqueOrThrow({
    select: { gateCommands: true },
    where: { id: request.repoId },
  });
  const repoOverrides = (repo.gateCommands ?? null) as Record<string, string> | null;
  if (repoOverrides && typeof repoOverrides[gate] === 'string' && repoOverrides[gate].length > 0) {
    return repoOverrides[gate];
  }

  return DEFAULT_COMMANDS[gate];
}

/**
 * Create a workspace and check out the work-request branch at the latest
 * remote commit. The implementer pushes commits to this branch, so gates
 * need to see the same tree the reviewer/CI sees.
 */
async function provisionGateWorkspace(
  request: RepoWorkRequest,
  gate: GateName,
  branchOverride?: string
): Promise<{
  workspace: Workspace;
  branch: string;
}> {
  const [repo, workflowDefaults] = await Promise.all([
    prisma.connection.findUniqueOrThrow({ where: { id: request.repoId } }),
    resolveWorkflowDefaults(),
  ]);
  const branch = branchOverride ?? `${workflowDefaults.branchPrefix}/${request.externalTicketId}`;

  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  const workspace = await createWorkspace(
    authedCloneUrl,
    branch,
    repo.defaultBranch,
    repo.executorImage ?? 'node:24-alpine'
  );

  // createWorkspace produces a fresh local branch from the default branch.
  // For gates we want the implementer's pushed commits, so fetch + reset.
  // If the remote branch doesn't exist yet (e.g. gate runs before first
  // push), the reset will fail and the implementer's local copy stays.
  try {
    await workspace.exec(`git fetch origin ${shellQuote(branch)}`);
    await workspace.exec(`git reset --hard origin/${shellQuote(branch)}`);
  } catch {
    // Gate runs against the local branch starting at defaultBranch.
    heartbeat(`gate ${gate}: remote branch not found, using clone HEAD`);
  }
  return { branch, workspace };
}

/**
 * Run a single gate. Encapsulates the workspace lifecycle, command
 * resolution, capture + artifact storage, and result shaping.
 */
async function runGate(gate: GateName, input: GateInput): Promise<GateResult> {
  heartbeat(`gate ${gate}: resolving command`);
  const command = await resolveCommand(gate, input.request, input.command);

  if (!command) {
    return {
      exitCode: 0,
      passed: true,
      summary: `${gate}: no command configured; treating as no-op`,
    };
  }

  const { workspace } = await provisionGateWorkspace(input.request, gate, input.branch);
  try {
    heartbeat(`gate ${gate}: running command`);
    const result = await workspace.execCapture(command, { timeoutMs: input.timeoutMs });

    const fullLog = `$ ${command}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
    const runId = await currentWorkflowRunId();
    const artifact = await putArtifact({
      body: fullLog,
      contentType: 'text/plain; charset=utf-8',
      kind: ARTIFACT_KIND[gate],
      runId,
    }).catch(() => null); // artifact failure should not mask the gate result

    const tail = truncate(`${result.stderr || result.stdout}`.trim(), 4000);
    const passed = result.exitCode === 0 && !result.signal;

    const gateResult: GateResult = {
      artifactId: artifact?.id,
      exitCode: result.exitCode,
      passed,
      ...(result.signal ? { signal: result.signal } : {}),
      summary: passed
        ? `${gate} passed (exit 0)`
        : `${gate} failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}): ${tail}`,
    };

    // P0 evals: capture the gate verdict as a normalized signal (best-effort).
    await recordGateEval(gate, gateResult, runId);

    return gateResult;
  } finally {
    await workspace.destroy();
  }
}

export async function runLint(input: GateInput): Promise<GateResult> {
  return runGate('runLint', input);
}

export async function runTypecheck(input: GateInput): Promise<GateResult> {
  return runGate('runTypecheck', input);
}

export async function runTests(input: GateInput): Promise<GateResult> {
  return runGate('runTests', input);
}

export async function runBuild(input: GateInput): Promise<GateResult> {
  return runGate('runBuild', input);
}

export async function runVulnScan(input: GateInput): Promise<GateResult> {
  return runGate('runVulnScan', input);
}

export async function runPerfBench(input: GateInput): Promise<GateResult> {
  return runGate('runPerfBench', input);
}

/**
 * Re-runs the implementer agent with a failed quality gate's output as
 * context. Mirrors `executeCIFixImplementation` / `executeReviewFixImplementation`
 * but accepts a gate name + artifact reference so the prompt can be tailored.
 *
 * The spec is expected to wire this in after a gate fails (typically gated
 * by a cond node checking `nodes.<gate>.output.passed == false`) and bind
 * the failed gate's output via `inputs.gateOutput`.
 */
export interface GateFixInput {
  /** Name of the gate that failed (e.g. 'runTests'). */
  gateName: string;
  /** Result returned by the failed gate. The activity loads full logs from artifactId if present. */
  gateOutput: GateResult;
  /** Previous code state, for context. */
  previousCodeResult: CodeResult;
  /** Optional system prompt override from workflow step config. */
  systemPromptOverride?: string;
}

export async function executeGateFixImplementation(input: GateFixInput): Promise<CodeResult> {
  const { gateName, gateOutput, previousCodeResult, systemPromptOverride } = input;

  // Load full gate logs from the artifact store, falling back to the inline
  // summary if the artifact is missing or unreadable.
  let gateLogs = gateOutput.summary;
  if (gateOutput.artifactId) {
    try {
      const { getArtifactText } = await import('../lib/artifactStore.js');
      gateLogs = (await getArtifactText(gateOutput.artifactId)).slice(-50_000);
    } catch {
      // fall back to summary
    }
  }

  return runImplementerFixSession({
    // Re-run the failed gate against the fixed code (mirrors the system
    // prompt's "Re-run the affected gate locally" instruction). Tests still
    // run afterwards as a regression check so a fix that silences the gate
    // but breaks tests is caught.
    afterGenerate: async (workspace, repo) => {
      if (
        gateName === 'unknown' ||
        (DEFAULT_COMMANDS as Record<string, string | null>)[gateName] === undefined
      ) {
        return `${gateName} not re-runnable (no command resolved)`;
      }
      const rerunCommand = await resolveCommand(
        gateName as GateName,
        { externalTicketId: '', repoId: repo.id } as RepoWorkRequest,
        undefined
      );
      if (!rerunCommand) {
        return `${gateName} not re-runnable (no command resolved)`;
      }
      heartbeat(`gate fix: re-running ${gateName}`);
      const rerun = await workspace.execCapture(rerunCommand);
      const passed = rerun.exitCode === 0 && !rerun.signal;
      return `${gateName} ${passed ? 'passing' : 'still failing'}`;
    },
    agentKey: 'gateFixer',
    commitMessage: `auto: fix ${gateName} for ${previousCodeResult.branch}`,
    defaultSystemPrompt: GATE_FIX_SYSTEM_PROMPT,
    mode: 'GATE_FIX',
    notes: (testResult, extraNote) =>
      `Gate fix iteration for ${gateName}. ${extraNote ?? `${gateName} re-run skipped`}. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    previousCodeResult,
    systemPromptOverride,
    usageEventName: 'llm.gate_fix',
    userPayload: {
      failedGate: gateName,
      gateExitCode: gateOutput.exitCode,
      gateLogs,
    },
  });
}
