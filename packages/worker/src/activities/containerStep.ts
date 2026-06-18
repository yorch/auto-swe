import { randomUUID } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { assertShellImageAllowed } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import { execShellAsync } from '../lib/execUtils.js';

/**
 * Container-contract coded step (P4/WS4 + P5 transports). Runs `image` in the
 * locked-down ephemeral container (no Docker socket, `--cap-drop=ALL`, read-only
 * root, `--network=none` unless `egress`), passing the resolved node inputs as
 * JSON on the `CONTAINER_STEP_INPUT` env var. The result is bound at
 * `nodes.<id>.output.result`. Untrusted code never enters the worker process.
 * Same image allowlist + egress allowlist as `shell`.
 *
 * Transports (how the container returns its result):
 *  - `'stdout'` (default): the container prints a single JSON object to stdout.
 *  - `'ndjson'`: the container streams newline-delimited JSON events; each is
 *    captured (and heartbeated) as it arrives, the result is the last event of
 *    `{ "type": "result", "result": … }` (or the last bare JSON line), and all
 *    events are also exposed at `nodes.<id>.output.events`.
 */
export type ContainerStepTransport = 'stdout' | 'ndjson';

export interface ContainerStepInput {
  request: RepoWorkRequest;
  image: string;
  command?: string;
  inputs?: Record<string, unknown>;
  network?: 'none' | 'egress';
  memory?: string;
  cpus?: number;
  timeoutMs?: number;
  transport?: ContainerStepTransport;
}

export interface ContainerStepResult {
  result: unknown;
  /** Streamed NDJSON events, when `transport: 'ndjson'`. */
  events?: unknown[];
}

export async function runContainerStep(input: ContainerStepInput): Promise<ContainerStepResult> {
  if (!input.command) {
    throw new Error('containerStep requires a command (the sandbox runs `sh -c <command>`)');
  }

  // Team allowlists: a container step is governed exactly like a shell step.
  const conn = await prisma.connection.findUnique({
    include: { team: { select: { egressAllowlist: true, shellImageAllowlist: true } } },
    where: { id: input.request.repoId },
  });
  const imageAllowlist = (conn?.team?.shellImageAllowlist as string[] | null) ?? [];
  const egressAllowlist = (conn?.team?.egressAllowlist as string[] | null) ?? [];
  // Throws ShellImageNotAllowedError if the image isn't on the effective allowlist.
  assertShellImageAllowed(input.image, imageAllowlist);

  const transport: ContainerStepTransport = input.transport ?? 'stdout';
  // NDJSON: collect each parsed line-event as it streams in and heartbeat so a
  // long-running, chatty step keeps its activity alive on output (not just the
  // 30s wall-clock pump). Non-JSON lines are kept as raw log strings.
  const events: unknown[] = [];
  const onStdoutLine =
    transport === 'ndjson'
      ? (line: string) => {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            return;
          }
          try {
            events.push(JSON.parse(trimmed));
          } catch {
            events.push({ log: trimmed, type: 'log' });
          }
          heartbeat({ events: events.length });
        }
      : undefined;

  // Stateless step → a throwaway empty volume for /workspace (no repo clone).
  const volume = `cstep-${randomUUID()}`;
  await execShellAsync(`docker volume create ${volume}`, {
    heartbeatLabel: 'container-step: volume',
  });
  try {
    const res = await runEphemeralContainer({
      command: input.command,
      cpus: input.cpus,
      egressAllowlist,
      env: { CONTAINER_STEP_INPUT: JSON.stringify(input.inputs ?? {}) },
      image: input.image,
      memory: input.memory,
      network: input.network ?? 'none',
      ...(onStdoutLine ? { onStdoutLine } : {}),
      timeoutMs: input.timeoutMs,
      workspaceMount: volume,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `containerStep exited ${res.exitCode}: ${(res.stderr || res.stdout || '').slice(0, 2000)}`
      );
    }
    if (transport === 'ndjson') {
      return { events, result: resultFromEvents(events) };
    }
    let result: unknown;
    try {
      result = JSON.parse(res.stdout.trim() || 'null');
    } catch {
      throw new Error(
        `containerStep did not emit valid JSON on stdout: ${res.stdout.slice(0, 500)}`
      );
    }
    return { result };
  } finally {
    await execShellAsync(`docker volume rm -f ${volume}`, {
      heartbeatLabel: 'container-step: cleanup',
    }).catch(() => {
      // best-effort cleanup; a leaked empty volume is harmless
    });
  }
}

/**
 * The NDJSON result is the last `{ type: 'result', result }` event the container
 * emitted; absent that, the last bare JSON value (ignoring `log`/`type:'log'`
 * progress lines). Returns null when the stream carried no result.
 */
function resultFromEvents(events: unknown[]): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && typeof e === 'object' && (e as { type?: unknown }).type === 'result') {
      return (e as { result?: unknown }).result ?? null;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && typeof e === 'object' && (e as { type?: unknown }).type === 'log') {
      continue;
    }
    return e ?? null;
  }
  return null;
}
