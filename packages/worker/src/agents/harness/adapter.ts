import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Workspace } from '../../activities/workspace.js';
import type { AgentTracer } from '../../lib/agentTracer.js';
import type { ContainerPlatform } from './binary.js';
import type { ToolDecision } from './policy.js';
import type { SpentByModel, UsageNormaliser, UsageTotals } from './usage.js';

/** The checkout inside every workspace container (`createWorkspace` clones here). */
export const WORKSPACE_DIR = '/workspace/target-repo';
/**
 * Where a harness lives inside the container: beside the checkout, not in it,
 * so `git add -A` can never sweep a binary, its transcripts or its home into a
 * commit (the same reason tool output is offloaded to `/workspace/.tool-output`).
 */
export const HARNESS_DIR = '/workspace/.harness';
/** The harness's `HOME` inside the container. */
export const HARNESS_HOME = `${HARNESS_DIR}/home`;

/**
 * What a harness can guarantee. The registry refuses an adapter that cannot
 * enforce the per-call policy, so a harness is never selectable on the strength
 * of its in-container configuration alone.
 */
export interface HarnessCapabilities {
  /**
   * The harness asks the worker before EVERY tool call it makes, over a channel
   * the worker owns (not a process the agent can reach inside the container),
   * waits for the answer, and does not run a call the worker refuses — and no
   * file in the repository or the container can grant a call without that
   * answer. Without this, the worker's scanners are advisory for that harness.
   */
  enforcesPerCallPolicyInWorker: boolean;
}

/** How the worker gets a harness binary into a container and keeps it honest. */
export interface HarnessProvisioning {
  /** The binary's path inside the container, under {@link HARNESS_DIR}. */
  containerPath: string;
  /** The worker's own copy for the container's platform; throws non-retryable when it has none. */
  resolveBinary(platform: ContainerPlatform): string;
  /** SHA-256 of the worker's copy, compared with the container's before every turn. */
  sha256(hostPath: string): Promise<string>;
  /** Anything else the container needs once per workspace (a shell, the harness's home). */
  prepareContainer?(workspace: Workspace): Promise<void>;
}

/** How one `docker exec` of the harness binary is started. */
export interface HarnessSpawn {
  /** Arguments for the binary. */
  args: string[];
  /** `docker exec -e` arguments placed first, so the runtime's own `-e` below win any clash. */
  leadingEnvArgs?: string[];
  /**
   * Secrets by name. Each is named on the `docker exec` command line without a
   * value, and docker reads it from its own environment, so the value never
   * appears on a command line or in `ps`.
   */
  secretEnv: Record<string, string>;
  /** Plain `NAME=value` settings for the harness process. */
  env: string[];
  signal?: AbortSignal;
}

/**
 * The shared half of one turn, handed to the adapter. It owns the parts every
 * harness needs and none may get wrong: the exec tag, cancellation, the policy
 * deadline, fail-closed decisions and trace bounding.
 */
export interface HarnessTurn {
  workspace: Workspace;
  /** The abort controller wired to the activity's cancellation; give it to the harness's client. */
  abort: AbortController;
  /** Start the harness binary in the container, tagged for cleanup, its stderr drained. */
  spawn(spawn: HarnessSpawn): ChildProcessByStdio<Writable, Readable, Readable>;
  /** The last few KiB the harness wrote to stderr: what explains a run that died. */
  stderrTail(): string;
  heartbeat(): void;
  /** Throws the activity's cancellation if it was cancelled; call it before reporting any other failure. */
  throwIfCancelled(): void;
  /**
   * Whether the caller's deadline (an agent run's wall clock) has passed. A
   * deadline aborts the turn like a cancellation, but it is a stop, not a
   * failure: the adapter returns `stoppedReason: 'wall_clock'` with what the
   * turn spent.
   */
  deadlineReached(): boolean;
  /**
   * The worker's verdict on one native tool call: the adapter's `decide`,
   * bounded by the policy deadline, a throw turned into a deny, and a refusal
   * traced with its security tag. `callId` pairs it with the completion below.
   */
  decide(
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
    harnessCwd?: string
  ): Promise<ToolDecision>;
  /** Trace a call that ran; returns the warning its decision carried, for the model. */
  completed(
    callId: string,
    call: { toolName: string; inputJson: unknown; output: unknown }
  ): { warning?: string };
  /** Trace a call that ran and failed. */
  failed(callId: string, call: { toolName: string; inputJson: unknown; error: unknown }): void;
  /**
   * What one model call has reported spending so far, as the harness streams it.
   * A later report for the same `callId` replaces the earlier one; a report for a
   * different call means every earlier call is complete, and a caller that meters
   * per call (`onCallSpent`) is debited for it then. Adapters report every call
   * they see; without `onCallSpent` this does nothing.
   */
  callUsage(callId: string, modelSpec: string, usage: UsageTotals): void;
}

/** What the adapter's turn reports, before its usage is normalised. */
export interface HarnessTurnResult<Report> {
  text?: string;
  toolCallCount: number;
  usage: Report;
  /** Model calls the turn made, when the harness counts them. */
  steps?: number;
  /** The turn used its whole turn cap, or the caller's deadline stopped it. Neither is a failure. */
  stoppedReason?: 'max_steps' | 'wall_clock';
}

/**
 * One harness, adapted to the implementer runtime. An adapter is built per
 * runtime (one workspace, one session) and holds the harness's session state.
 *
 * The adapter owns only what is the harness's own: how it is provisioned, how
 * its native tool calls map onto the canonical vocabulary, how it reports usage,
 * and how a turn is driven over its protocol. Everything else is
 * `harnessRuntime`'s.
 */
export interface HarnessAdapter<Report> {
  /** The runtime kind (`workspace.implementerRuntime` value); also the heartbeat label. */
  kind: string;
  /** Names the harness in messages (`Claude Code`). */
  label: string;
  capabilities: HarnessCapabilities;
  provisioning: HarnessProvisioning;
  usage: UsageNormaliser<Report>;
  /**
   * The verdict on one native tool call. Implementations translate the call into
   * the canonical vocabulary and decide it with `decideCanonicalCall`, so the
   * scanners apply; a throw is a deny.
   */
  decide(
    toolName: string,
    input: Record<string, unknown>,
    harnessCwd?: string
  ): Promise<ToolDecision>;
  /**
   * Drive one turn. Every tool call must go through `turn.decide` before it
   * runs. A failure that was billed passes its usage report through
   * {@link withUsageReport} so the runtime can accrue it.
   */
  runTurn(
    turn: HarnessTurn,
    input: { system: string; user: string }
  ): Promise<HarnessTurnResult<Report>>;
  /** Releases anything the adapter holds beyond one turn. */
  close?(): Promise<void>;
}

/** What every harness runtime is built from, besides its adapter. */
export interface HarnessRuntimeOptions<Access> {
  access: Access;
  /** Load the repository's own harness configuration (`.claude`, `CLAUDE.md`, …). */
  loadProjectSettings: boolean;
  /** `workspace.agentMaxSteps`, as the cap on turns in one harness run. */
  maxTurns: number;
  /**
   * The resolved Agent's `toolKeys` (`IMPLEMENTER_TOOL_IDS`), read as the Mastra
   * implementer reads them: null, absent or empty grants every tool.
   */
  toolKeys?: readonly string[] | null;
  /**
   * Exactly these workspace tool keys, in place of reading `toolKeys`: for a
   * caller whose tool rule is not the implementer's (an agent run grants only
   * what the Agent names). An empty list is no tools, never all of them.
   */
  exactToolKeys?: readonly string[];
  /**
   * A deadline (an agent run's wall clock). Unlike cancellation it is a stop,
   * not a failure: the turn ends with `stoppedReason: 'wall_clock'` and what it
   * spent, as the Mastra loop's deadline does.
   */
  deadline?: AbortSignal;
  /**
   * Per-call accounting: called, one at a time, with each model call's usage once
   * the call is complete, while the turn runs. It debits the call and may then
   * throw (the run's budget is exhausted); the turn is aborted and fails with
   * that error. A call handed here is not reported again in the turn's usage.
   * The harness reports totals only when its run ends, so without this a long
   * run is metered once, after it has spent.
   */
  onCallSpent?: (spent: SpentByModel) => Promise<void>;
  tracer: AgentTracer;
  workspace: Workspace;
}

const reports = new WeakMap<object, { report: unknown }>();

/**
 * Marks an adapter's failure with the usage report of the run that failed, so
 * the runtime can normalise it and accrue what was spent. The error is returned
 * unchanged, so its type and retry policy stand.
 */
export function withUsageReport<E>(err: E, report: unknown): E {
  if (typeof err === 'object' && err !== null) {
    reports.set(err, { report });
  }
  return err;
}

/** What {@link withUsageReport} recorded on a failure, if anything. */
export function usageReportOf(err: unknown): { report: unknown } | undefined {
  return typeof err === 'object' && err !== null ? reports.get(err) : undefined;
}
