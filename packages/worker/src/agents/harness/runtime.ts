import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import {
  EXEC_TAG_ENV,
  killTaggedProcessesScript,
  type Workspace,
} from '../../activities/workspace.js';
import type { AgentTracer } from '../../lib/agentTracer.js';
import { activityCancellationSignal, throwIfActivityCancelled } from '../../lib/cancellation.js';
import { spawnCaptureAsync } from '../../lib/execUtils.js';
import { type ImplementerRuntime, withSpentUsage } from '../implementerRuntime.js';
import {
  type HarnessAdapter,
  type HarnessProvisioning,
  type HarnessTurn,
  usageReportOf,
  WORKSPACE_DIR,
} from './adapter.js';
import { PLATFORM_PROBE, parseContainerPlatform } from './binary.js';
import { decideWithinDeadline, type ToolDecision } from './policy.js';
import { type SpentByModel, subtractSpent, summedCallsUsage, type UsageTotals } from './usage.js';

/** The stderr kept for an error message. */
const STDERR_TAIL_CHARS = 4000;

/** A tool result in a trace row is bounded: a read of a large file would otherwise fill the row. */
export const TRACE_OUTPUT_CHARS = 20_000;

/** `value` for a trace row, cut to {@link TRACE_OUTPUT_CHARS} with a note of what was dropped. */
export function forTrace(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > TRACE_OUTPUT_CHARS
    ? `${text.slice(0, TRACE_OUTPUT_CHARS)}… [${text.length - TRACE_OUTPUT_CHARS} more characters]`
    : value;
}

/**
 * Learn the container's platform, run the adapter's own preparation, and return
 * the worker's binary that matches the container. Once per workspace.
 */
async function prepareContainer(
  workspace: Workspace,
  provisioning: HarnessProvisioning
): Promise<string> {
  const probe = await workspace.execCapture(PLATFORM_PROBE);
  const binary = provisioning.resolveBinary(parseContainerPlatform(probe.stdout));
  await provisioning.prepareContainer?.(workspace);
  return binary;
}

/** The hash `sha256sum` reports for the container's copy of the binary, or '' without one. */
async function installedSha256(workspace: Workspace, containerPath: string): Promise<string> {
  const out = await workspace.execCapture(`sha256sum ${containerPath} 2>/dev/null`);
  return out.exitCode === 0 ? (out.stdout.trim().split(/\s+/)[0] ?? '') : '';
}

/**
 * Make sure the container's copy of the binary is the worker's, before every
 * turn. The copy sits on a path the agent can write, and a replaced binary
 * would run without the worker's policy and report whatever usage it liked; so
 * a copy whose hash differs is replaced, and one that still differs fails the
 * turn. The copy is skipped when the right binary is already there.
 */
async function installBinary(
  workspace: Workspace,
  adapter: Pick<HarnessAdapter<unknown>, 'kind' | 'label' | 'provisioning'>,
  binary: string
): Promise<void> {
  const { containerPath } = adapter.provisioning;
  const expected = await adapter.provisioning.sha256(binary);
  if ((await installedSha256(workspace, containerPath)) === expected) {
    return;
  }
  const copy = await spawnCaptureAsync(
    'docker',
    ['cp', binary, `${workspace.containerId}:${containerPath}`],
    { heartbeatLabel: `${adapter.kind}: install binary`, timeoutMs: 120_000 }
  );
  if (copy.exitCode !== 0) {
    throw new Error(
      `Could not copy the ${adapter.label} binary into the workspace: ${copy.stderr}`
    );
  }
  if ((await installedSha256(workspace, containerPath)) !== expected) {
    throw ApplicationFailure.nonRetryable(
      `The ${adapter.label} binary in the workspace does not match the worker's copy after installing it. The image needs \`sha256sum\` (coreutils or busybox) for the runtime to verify it.`,
      'HARNESS_BINARY_UNVERIFIED'
    );
  }
}

/** An implementer runtime that may hold something open across turns. */
export interface HarnessRuntime extends ImplementerRuntime {
  close?(): Promise<void>;
}

/**
 * A harness as an implementer runtime: the shared half of every harness, around
 * the adapter's protocol.
 *
 * The harness's client runs here, in the worker; its binary runs in the
 * workspace container, reached through `docker exec -i`. Before each turn the
 * container's binary is verified against the worker's. Every process the turn
 * starts carries an exec tag, and the tag is killed when the turn ends however
 * it ends: `docker exec` does not stop what it started when its client dies.
 * The activity's cancellation aborts the turn and is what a cancelled turn
 * reports; a caller's deadline aborts it too, and the adapter reports that as a
 * stop. Every tool call is decided by the worker, through `turn.decide`,
 * within {@link POLICY_DECISION_MS} and failing closed.
 *
 * With `onCallSpent`, each model call is debited as soon as it is complete
 * (the next call has begun), in order, one at a time; a throw from it aborts the
 * turn, which then fails with that error. The turn's own report is reconciled
 * against what was debited, so nothing is counted twice: only the remainder —
 * the last call, and any the harness made without reporting — is returned or
 * carried on a failure.
 *
 * Refuses an adapter that does not declare it enforces that per-call policy.
 */
export function harnessRuntime<Report>(
  adapter: HarnessAdapter<Report>,
  options: {
    deadline?: AbortSignal;
    onCallSpent?: (spent: SpentByModel) => Promise<void>;
    tracer: AgentTracer;
    workspace: Workspace;
  }
): HarnessRuntime {
  if (!adapter.capabilities.enforcesPerCallPolicyInWorker) {
    throw ApplicationFailure.nonRetryable(
      `${adapter.label} cannot have every tool call decided by the worker, so it cannot run a workspace.`,
      'HARNESS_POLICY_UNENFORCEABLE'
    );
  }
  const { deadline, onCallSpent, tracer, workspace } = options;
  let prepared: Promise<string> | undefined;

  async function runTurn(input: { system: string; user: string }) {
    if (!prepared) {
      const preparing = prepareContainer(workspace, adapter.provisioning);
      prepared = preparing;
      // A failed preparation is not remembered: the next turn tries again.
      preparing.catch(() => {
        if (prepared === preparing) {
          prepared = undefined;
        }
      });
    }
    await installBinary(workspace, adapter, await prepared);

    const tag = randomBytes(8).toString('hex');
    const abort = new AbortController();
    const cancellation = activityCancellationSignal();
    const onCancel = () => abort.abort();
    cancellation?.addEventListener('abort', onCancel, { once: true });
    deadline?.addEventListener('abort', onCancel, { once: true });
    if (cancellation?.aborted || deadline?.aborted) {
      abort.abort();
    }

    let stderrTail = '';
    // Per-call accounting: the call still streaming, the calls already debited,
    // what they came to, and the first error a debit threw.
    let openCall: { id: string; modelSpec: string; usage: UsageTotals } | undefined;
    const debitedCalls = new Set<string>();
    const accrued: SpentByModel = [];
    let debits: Promise<void> = Promise.resolve();
    let debitError: { error: unknown } | undefined;
    const debit = (call: { modelSpec: string; usage: UsageTotals }) => {
      const spent = summedCallsUsage('', [{ model: call.modelSpec, usage: call.usage }]);
      if (!onCallSpent || spent.length === 0) {
        return;
      }
      debits = debits.then(async () => {
        if (debitError) {
          return;
        }
        // Counted as debited before the callback runs: a callback that throws after
        // recording the spend (an exhausted budget) must not have it charged again.
        accrued.push(...spent);
        try {
          await onCallSpent(spent);
        } catch (error) {
          debitError = { error };
          abort.abort();
        }
      });
    };
    // What the turn still owes once its report is in: the report less what was
    // debited call by call.
    const owed = (spent: SpentByModel) => (onCallSpent ? subtractSpent(spent, accrued) : spent);
    const startedAt = new Map<string, number>();
    const warnings = new Map<string, { tag?: string; text: string }>();
    const elapsed = (id: string) => Date.now() - (startedAt.get(id) ?? Date.now());

    const turn: HarnessTurn = {
      abort,
      callUsage(callId, modelSpec, usage) {
        if (!onCallSpent || debitedCalls.has(callId)) {
          return;
        }
        if (openCall && openCall.id !== callId) {
          debitedCalls.add(openCall.id);
          debit(openCall);
        }
        openCall = { id: callId, modelSpec, usage };
      },
      completed(callId, { inputJson, output, toolName }) {
        const warning = warnings.get(callId);
        tracer.addToolCall({
          durationMs: elapsed(callId),
          error: warning?.tag,
          inputJson,
          outputJson: forTrace(output),
          toolName,
        });
        return { warning: warning?.text };
      },
      deadlineReached: () => deadline?.aborted ?? false,
      async decide(callId, toolName, toolInput, harnessCwd) {
        startedAt.set(callId, Date.now());
        const verdict: ToolDecision = await decideWithinDeadline(() =>
          adapter.decide(toolName, toolInput, harnessCwd)
        );
        if (!verdict.allow) {
          tracer.addToolCall({
            durationMs: elapsed(callId),
            error: verdict.securityTag ?? 'blocked by workspace policy',
            inputJson: toolInput,
            outputJson: { result: verdict.reason },
            toolName,
          });
        } else if (verdict.warning) {
          warnings.set(callId, { tag: verdict.securityTag, text: verdict.warning });
        }
        return verdict;
      },
      failed(callId, { error, inputJson, toolName }) {
        tracer.addToolCall({
          durationMs: elapsed(callId),
          error: String(error).slice(0, 1000),
          inputJson,
          toolName,
        });
      },
      heartbeat: () => heartbeat(adapter.kind),
      spawn({ args, env, leadingEnvArgs = [], secretEnv, signal }) {
        const child = spawn(
          'docker',
          [
            'exec',
            '-i',
            '-w',
            WORKSPACE_DIR,
            ...leadingEnvArgs,
            '-e',
            `${EXEC_TAG_ENV}=${tag}`,
            // Named without a value: docker reads it from its own environment below,
            // so a secret never appears on a command line or in `ps`.
            ...Object.keys(secretEnv).flatMap((name) => ['-e', name]),
            ...env.flatMap((pair) => ['-e', pair]),
            workspace.containerId,
            adapter.provisioning.containerPath,
            ...args,
          ],
          {
            env: { ...process.env, ...secretEnv },
            signal,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );
        // Drained here whatever the client does with it: unread, a full pipe stalls
        // the harness, and its tail is what explains a run that died.
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (data: string) => {
          stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
        });
        return child;
      },
      stderrTail: () => stderrTail,
      throwIfCancelled: throwIfActivityCancelled,
      workspace,
    };

    try {
      let result: Awaited<ReturnType<typeof adapter.runTurn>>;
      try {
        result = await adapter.runTurn(turn, input);
      } catch (err) {
        await debits;
        // A cancelled activity surfaces as a killed process: report the cancellation.
        throwIfActivityCancelled();
        const billed = usageReportOf(err);
        const spent = billed ? owed(adapter.usage.normalise(billed.report as Report)) : undefined;
        // A debit that threw aborted the turn: that error, not the abort, is the failure.
        const failure = debitError ? debitError.error : err;
        // The failed run was billed for what it spent: the error carries it.
        throw spent ? withSpentUsage(failure, spent) : failure;
      }
      const spent = adapter.usage.normalise(result.usage);
      await debits;
      if (debitError) {
        // The budget ran out on a call the turn made before it finished: the turn
        // fails as the Mastra loop's would, carrying what was not yet debited.
        throw withSpentUsage(debitError.error, owed(spent));
      }
      return {
        steps: result.steps,
        stoppedReason: result.stoppedReason,
        text: result.text,
        toolCallCount: result.toolCallCount,
        usageByModel: owed(spent),
      };
    } finally {
      cancellation?.removeEventListener('abort', onCancel);
      deadline?.removeEventListener('abort', onCancel);
      // Every process the harness began carries the tag, so this leaves nothing running between turns.
      await workspace.exec(killTaggedProcessesScript(tag)).catch(() => undefined);
    }
  }

  return { close: adapter.close?.bind(adapter), runTurn };
}
