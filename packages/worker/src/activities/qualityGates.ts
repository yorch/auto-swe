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

import { randomUUID } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { putArtifact } from '@auto-swe/shared/lib/artifactStore';
import { detectedGateDefaults } from '@auto-swe/shared/lib/stackDetection';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { activityInfo, heartbeat } from '@temporalio/activity';
import { GATE_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import {
  currentRunningWorkflowRunId,
  currentTemporalRunId,
  currentWorkflowRunId,
} from '../lib/activityContext.js';
import { currentNodeTag } from '../lib/activityNodeTag.js';
import { getErrorMessage } from '../lib/errors.js';
import { recordGateEval } from '../lib/evalCapture.js';
import { throwIfActivityCancelled } from '../lib/execUtils.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { resolveRequestBaseBranch } from '../lib/runBaseBranch.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { runImplementerFixSession } from './implementerSession.js';
import {
  createWorkspace,
  fetchBranchesSubcommand,
  shellQuote,
  type Workspace,
} from './workspace.js';

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
  /**
   * The command the gate actually ran, after step → repo → default
   * resolution. A gate-fix step re-runs exactly this, so a template's
   * step-level `config.command` is honoured on the re-run too.
   */
  command?: string;
  /** Worker-generated correlation to the persisted trusted gate provenance row. */
  evidenceCorrelation?: string;
  /** Temporal activity attempt that produced this gate result. */
  activityAttempt?: number;
  /** Worker-owned gate identity paired with evidenceCorrelation. */
  gateName?: GateName;
}

export const DEFAULT_COMMANDS: Record<GateName, string | null> = {
  runBuild: 'yarn build',
  runLint: 'yarn lint',
  // runPerfBench has no sensible default: the operator supplies one.
  runPerfBench: null,
  runTests: 'yarn test',
  runTypecheck: 'yarn typecheck',
  runVulnScan: 'yarn npm audit --severity high',
};

type TrustedKnowledgeEvidenceWriter = {
  createMany(args: {
    data: Array<{
      activityAttempt: number;
      artifactId: string;
      evidenceCorrelation: string;
      gateName: GateName;
      outcome: 'PASSED';
      producer: 'QUALITY_GATE';
      recordingId: string;
      runId: string;
      specNodeId: string;
      stepAttempt: number;
      summary: string;
      temporalRunId: string;
    }>;
    skipDuplicates: true;
  }): Promise<{ count: number }>;
  findUnique(args: {
    where: {
      runId_recordingId_stepAttempt_activityAttempt_producer_gateName: {
        activityAttempt: number;
        gateName: GateName;
        producer: 'QUALITY_GATE';
        recordingId: string;
        runId: string;
        stepAttempt: number;
      };
    };
  }): Promise<{
    activityAttempt: number;
    artifactId: string | null;
    evidenceCorrelation: string;
    gateName: string;
    outcome: 'PASSED';
    producer: 'QUALITY_GATE';
    recordingId: string;
    runId: string;
    specNodeId: string;
    stepAttempt: number;
    summary: string;
    temporalRunId: string;
  } | null>;
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
 * null when no command is configured anywhere, which the caller reports as a
 * FAILED gate (see {@link noCommandResult}): a gate that cannot run has not
 * verified anything, and its node's `onFail: 'warn'` is the supported way to
 * make it optional. Only `runPerfBench` has no built-in default.
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
    select: { detectedStack: true, gateCommands: true },
    where: { id: requireRepoId(request, 'qualityGate') },
  });
  const repoOverrides = (repo.gateCommands ?? null) as Record<string, string> | null;
  // Whitespace-only counts as absent, like the step override above: a command
  // that runs nothing must not read as a gate that ran and passed.
  if (
    repoOverrides &&
    typeof repoOverrides[gate] === 'string' &&
    repoOverrides[gate].trim().length > 0
  ) {
    return repoOverrides[gate];
  }

  // A repository whose root is a non-Node stack gets that stack's command, or
  // none: the built-in `yarn` commands below belong to Node, and running one in a
  // Python or JVM workspace exits 127 and reads as broken code. A gate the stack
  // has no unambiguous command for resolves to null — reported as unconfigured.
  const stackDefaults = detectedGateDefaults(repo.detectedStack);
  if (stackDefaults) {
    return stackDefaults[gate] ?? null;
  }

  return DEFAULT_COMMANDS[gate];
}

/**
 * The verdict for a gate with no command to run, after step config → repo
 * override → built-in default all came back empty. It is a FAILURE, not a
 * no-op: the step's whole job is to verify something and it verified nothing.
 *
 * This is reachable only for a gate with no built-in default (`runPerfBench`).
 * A template that wants such a gate to be optional says so in the spec with
 * `onFail: 'warn'`, which keeps the choice visible where it is made instead of
 * hiding behind an unset command — and does not report an unrun benchmark as a
 * pass to a `cond` branching on `nodes.<id>.output.passed`.
 */
export function noCommandResult(gate: GateName): GateResult {
  return {
    exitCode: 0,
    passed: false,
    summary:
      `${gate}: no command configured, so the gate cannot run. Set 'command' on the step, ` +
      `'${gate}' in the repository's gate commands, or give the node \`onFail: 'warn'\` to ` +
      'make it optional.',
  };
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
    prisma.connection.findUniqueOrThrow({
      include: { installation: { select: { host: true, installationId: true } } },
      where: { id: requireRepoId(request, 'qualityGate') },
    }),
    resolveWorkflowDefaults(),
  ]);
  const branch = branchOverride ?? `${workflowDefaults.branchPrefix}/${request.externalTicketId}`;

  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  // Cloned at the run's base, which the work branch was cut from, so the shallow clone
  // shares history with it.
  const baseBranch = await resolveRequestBaseBranch(request, repo);
  const workspace = await createWorkspace(
    authedCloneUrl,
    branch,
    baseBranch,
    repo.executorImage ?? undefined,
    undefined,
    undefined,
    { teamId: repo.teamId }
  );

  // createWorkspace produces a fresh local branch from the base branch.
  // For gates we want the implementer's pushed commits, so fetch + reset.
  //
  // A failure here fails the gate. It used to fall through and run the gate
  // against the default branch's HEAD — code the change never touched — so a
  // missing branch or a transient fetch error reported the change as green.
  // The error is thrown (and the activity retries) rather than returned as a
  // failed verdict, because nothing about the change was actually checked.
  try {
    await workspace.gitAuthed(fetchBranchesSubcommand([branch]));
    await workspace.exec(`git reset --hard origin/${shellQuote(branch)}`);
  } catch (err) {
    await workspace.destroy();
    throw new Error(
      `gate ${gate}: could not check out branch '${branch}' from origin, so the gate ` +
        `cannot run against the change (refusing to run it against '${baseBranch}'): ` +
        getErrorMessage(err).slice(0, 500)
    );
  }
  return { branch, workspace };
}

/**
 * Run a single gate. Encapsulates the workspace lifecycle, command
 * resolution, capture + artifact storage, and result shaping.
 */
/**
 * Run one gate's command in an already-provisioned workspace: capture the run,
 * store the log as an artifact, shape the verdict, record the eval signal, and
 * attest trusted evidence. Extracted from {@link runGate} so a batched gate run
 * (one workspace, several commands) shares this path rather than a second copy
 * of the evidence rules.
 */
async function runGateCommand({
  gate,
  command,
  timeoutMs,
  workspace,
}: {
  gate: GateName;
  command: string;
  timeoutMs?: number;
  workspace: Workspace;
}): Promise<GateResult> {
  heartbeat(`gate ${gate}: running command`);
  const result = await workspace.execCapture(command, { timeoutMs });

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
    command,
    exitCode: result.exitCode,
    passed,
    ...(result.signal ? { signal: result.signal } : {}),
    summary: passed
      ? `${gate} passed (exit 0)`
      : `${gate} failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}): ${tail}`,
  };

  // P0 evals: capture the gate verdict as a normalized signal (best-effort).
  await recordGateEval(gate, gateResult, runId);

  // Only an executed, passed gate with its stored artifact and exact interpreter
  // dispatch can attest evidence. No-op gates and missing artifacts never do.
  if (passed && artifact?.id) {
    const tag = currentNodeTag();
    const activityAttempt = activityInfo().attempt;
    const evidenceCorrelation = randomUUID();
    const [exactRunId, temporalRunId] = await Promise.all([
      currentRunningWorkflowRunId(),
      Promise.resolve(currentTemporalRunId()),
    ]);
    if (
      tag &&
      tag.recordingId.length > 0 &&
      tag.specNodeId.length > 0 &&
      Number.isInteger(tag.stepAttempt) &&
      tag.stepAttempt > 0 &&
      Number.isInteger(activityAttempt) &&
      activityAttempt > 0 &&
      exactRunId &&
      temporalRunId
    ) {
      const attachedArtifact = await prisma.workflowArtifact.findFirst({
        select: { id: true },
        // A pending artifact has no stored payload yet; it is not evidence.
        where: { id: artifact.id, runId: exactRunId, status: 'ready' },
      });
      if (attachedArtifact) {
        // SAFETY: the schema and generated Prisma client define this worker-only evidence model.
        const evidenceWriter = (
          prisma as unknown as {
            trustedKnowledgeEvidence: TrustedKnowledgeEvidenceWriter;
          }
        ).trustedKnowledgeEvidence;
        const provenance = {
          activityAttempt,
          artifactId: artifact.id,
          evidenceCorrelation,
          gateName: gate,
          outcome: 'PASSED',
          producer: 'QUALITY_GATE',
          recordingId: tag.recordingId,
          runId: exactRunId,
          specNodeId: tag.specNodeId,
          stepAttempt: tag.stepAttempt,
          summary: `${gate} passed (exit 0)`,
          temporalRunId,
        } as const;
        const inserted = await evidenceWriter.createMany({
          data: [provenance],
          skipDuplicates: true,
        });
        const stored =
          inserted.count > 0
            ? provenance
            : await evidenceWriter.findUnique({
                where: {
                  runId_recordingId_stepAttempt_activityAttempt_producer_gateName: {
                    activityAttempt,
                    gateName: gate,
                    producer: 'QUALITY_GATE',
                    recordingId: tag.recordingId,
                    runId: exactRunId,
                    stepAttempt: tag.stepAttempt,
                  },
                },
              });
        if (
          stored &&
          stored.artifactId === provenance.artifactId &&
          typeof stored.evidenceCorrelation === 'string' &&
          stored.evidenceCorrelation.length > 0 &&
          stored.activityAttempt === provenance.activityAttempt &&
          stored.gateName === provenance.gateName &&
          stored.outcome === provenance.outcome &&
          stored.producer === provenance.producer &&
          stored.recordingId === provenance.recordingId &&
          stored.runId === provenance.runId &&
          stored.specNodeId === provenance.specNodeId &&
          stored.stepAttempt === provenance.stepAttempt &&
          stored.summary === provenance.summary &&
          stored.temporalRunId === provenance.temporalRunId
        ) {
          gateResult.activityAttempt = activityAttempt;
          gateResult.evidenceCorrelation = stored.evidenceCorrelation;
          gateResult.gateName = gate;
        }
      }
    }
  }

  return gateResult;
}

/**
 * Run a single gate. Encapsulates the workspace lifecycle, command
 * resolution, capture + artifact storage, and result shaping.
 */
async function runGate(gate: GateName, input: GateInput): Promise<GateResult> {
  heartbeat(`gate ${gate}: resolving command`);
  const command = await resolveCommand(gate, input.request, input.command);

  if (!command) {
    return noCommandResult(gate);
  }

  const { workspace } = await provisionGateWorkspace(input.request, gate, input.branch);
  try {
    return await runGateCommand({
      command,
      gate,
      timeoutMs: input.timeoutMs,
      workspace,
    });
  } finally {
    await workspace.destroy();
  }
}

/** One gate of a {@link runQualityGates} batch. */
export interface BatchGate {
  name: GateName;
  /** Per-gate command override, as a single gate node's `config.command` is. */
  command?: string;
  timeoutMs?: number;
}

export interface RunQualityGatesInput extends Omit<GateInput, 'command' | 'timeoutMs'> {
  gates: BatchGate[];
  /**
   * `'shared'` (default) provisions one workspace and runs every command in it,
   * which is the point of the step: lint, typecheck and tests would otherwise
   * clone and install the repository three times. The commands then share a
   * tree, so one that mutates files affects the gates after it — order them
   * cheap-and-read-only first, or use `'per-gate'`, which is exactly the six
   * single-gate steps run in sequence.
   */
  isolation?: 'shared' | 'per-gate';
  /** Stop at the first failing gate rather than running the rest. Default: run all. */
  stopOnFailure?: boolean;
}

export interface RunQualityGatesResult {
  /** True only when every gate ran and passed. The node's gate-failure branch reads this. */
  passed: boolean;
  summary: string;
  exitCode: number;
  /** Per-gate verdicts, keyed by gate name, for a `cond` on one gate's outcome. */
  gates: Record<string, GateResult>;
  failed: number;
  /** Gates that never ran because an earlier one failed under `stopOnFailure`. */
  skipped: GateName[];
}

/**
 * Run several quality gates, optionally in one workspace.
 *
 * The gates stay individually addressable — each keeps its own command
 * resolution, artifact, summary and trusted-evidence row — so this is a
 * provisioning optimisation, not a merged verdict. The aggregate `passed` is
 * what the interpreter's gate-failure branch reads, exactly as a single gate's
 * is.
 */
export async function runQualityGates(input: RunQualityGatesInput): Promise<RunQualityGatesResult> {
  const requested = input.gates.filter((g) => Object.hasOwn(DEFAULT_COMMANDS, g.name));
  if (requested.length === 0) {
    return {
      exitCode: 0,
      failed: 0,
      gates: {},
      passed: false,
      skipped: [],
      summary: 'runQualityGates: no gates named, so nothing was verified',
    };
  }

  const isolation = input.isolation ?? 'shared';
  const gates: Record<string, GateResult> = {};
  const skipped: GateName[] = [];
  let failed = 0;
  let stopped = false;

  // Resolve every command up front: a gate with nothing to run fails the batch
  // without provisioning a workspace for the rest.
  const resolved: Array<
    { gate: GateName; command: string } | { gate: GateName; result: GateResult }
  > = [];
  for (const { command: override, name } of requested) {
    heartbeat(`quality gates: resolving ${name}`);
    const command = await resolveCommand(name, input.request, override);
    resolved.push(
      command ? { command, gate: name } : { gate: name, result: noCommandResult(name) }
    );
  }

  if (isolation === 'per-gate') {
    for (const entry of resolved) {
      if (stopped) {
        skipped.push(entry.gate);
        continue;
      }
      const result =
        'result' in entry
          ? entry.result
          : await runGate(entry.gate, {
              command: entry.command,
              request: input.request,
              ...(input.branch ? { branch: input.branch } : {}),
            });
      gates[entry.gate] = result;
      if (!result.passed) {
        failed += 1;
        stopped = input.stopOnFailure === true;
      }
    }
  } else {
    const { workspace } = await provisionGateWorkspace(input.request, 'runLint', input.branch);
    try {
      for (const entry of resolved) {
        if (stopped) {
          skipped.push(entry.gate);
          continue;
        }
        const result =
          'result' in entry
            ? entry.result
            : await runGateCommand({
                command: entry.command,
                gate: entry.gate,
                timeoutMs: requested.find((g) => g.name === entry.gate)?.timeoutMs,
                workspace,
              });
        gates[entry.gate] = result;
        if (!result.passed) {
          failed += 1;
          stopped = input.stopOnFailure === true;
        }
        // A cancelled run must not keep spending on the remaining commands.
        if (!stopped) {
          throwIfActivityCancelled();
        }
      }
    } finally {
      await workspace.destroy();
    }
  }

  const ran = Object.values(gates);
  const passed = ran.length === requested.length && failed === 0;
  const names = requested.map((g) => g.name);
  const failing = names.filter((n) => gates[n]?.passed === false);
  const summary = passed
    ? `quality gates passed (${names.join(', ')})`
    : `quality gates failed: ${failing.length > 0 ? failing.join(', ') : 'nothing ran'}${
        skipped.length > 0 ? ` (skipped after the first failure: ${skipped.join(', ')})` : ''
      }`;

  return {
    exitCode: 0,
    failed,
    gates,
    passed,
    skipped,
    summary: truncate(summary, 4000),
  };
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
  /** Refuse, before the push, a change to a GitHub Actions workflow or action. */
  refuseWorkflowChanges?: boolean;
}

export async function executeGateFixImplementation(input: GateFixInput): Promise<CodeResult> {
  const { gateName, gateOutput, previousCodeResult, systemPromptOverride } = input;

  // Load full gate logs from the artifact store, falling back to the inline
  // summary if the artifact is missing or unreadable.
  let gateLogs = gateOutput.summary;
  if (gateOutput.artifactId) {
    try {
      const { getArtifactText } = await import('@auto-swe/shared/lib/artifactStore');
      gateLogs = (await getArtifactText(gateOutput.artifactId)).slice(-50_000);
    } catch {
      // fall back to summary
    }
  }

  return runImplementerFixSession({
    ...(input.refuseWorkflowChanges ? { refuseWorkflowChanges: true } : {}),
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
      // The failed gate reports the command it ran; resolving from scratch
      // would drop a step-level `config.command` and re-run the repo/default
      // command instead — a different check from the one that failed.
      const rerunCommand = await resolveCommand(
        gateName as GateName,
        { externalTicketId: '', repoId: repo.id } as RepoWorkRequest,
        gateOutput.command
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
    // The gate's own output, end first: where a lint or build failure is named.
    lessonQuery: `${gateName}: ${gateLogs.slice(-2_000)}`,
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
