import { EXEC_TAG_ENV, killTaggedProcessesScript } from '../../activities/workspace.js';
import { workspaceBackend } from '../../lib/workspaceBackend/index.js';
import { type HarnessExec, type HarnessExecResult, WORKSPACE_DIR } from './adapter.js';

/** Output kept from one command, stdout and stderr together; the rest is counted, not kept. */
export const MAX_EXEC_OUTPUT_BYTES = 10 * 1024 * 1024;

/** How often a running command heartbeats the activity. */
const HEARTBEAT_MS = 10_000;

/** Bounds the kill itself: a wedged container must not hold the turn open. */
const KILL_TIMEOUT_MS = 30_000;

/**
 * Run one command in the workspace container, tagged `tag`, and capture its
 * output as bytes.
 *
 * The script runs under `sh -c` in the checkout, with `args` as its positional
 * parameters, so a path or a command reaches it as one argument and is never
 * re-parsed by a shell on the worker. A timeout, `exec.signal` or `abort` kills
 * the local `docker exec` client and then every process in the container that
 * carries the tag: killing the client alone leaves the command running.
 *
 * Resolves for any exit status, a kill included; rejects only when `docker`
 * itself cannot be started.
 */
export function execInContainer(options: {
  containerId: string;
  tag: string;
  exec: HarnessExec;
  /** The turn's abort: a cancelled turn stops every command it is running. */
  abort: AbortSignal;
  heartbeat: () => void;
  maxOutputBytes?: number;
}): Promise<HarnessExecResult> {
  const { abort, containerId, exec, heartbeat, tag } = options;
  const cap = options.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
  const hasStdin = exec.stdin !== undefined;

  return new Promise<HarnessExecResult>((resolve, reject) => {
    const backend = workspaceBackend();
    const child = backend.spawn(
      backend.attach(containerId),
      ['sh', '-c', exec.script, 'sh', ...(exec.args ?? [])],
      {
        env: [`${EXEC_TAG_ENV}=${tag}`],
        stdin: hasStdin,
        stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        workdir: WORKSPACE_DIR,
      }
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let kept = 0;
    let droppedBytes = 0;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      const room = cap - kept;
      if (room <= 0) {
        droppedBytes += chunk.length;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      into.push(part);
      kept += part.length;
      droppedBytes += chunk.length - part.length;
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));

    let timedOut = false;
    let killing: Promise<unknown> | undefined;
    const kill = () => {
      if (killing) {
        return;
      }
      child.kill('SIGKILL');
      killing = backend
        .exec(backend.attach(containerId), ['sh', '-c', killTaggedProcessesScript(tag)], {
          heartbeatLabel: 'harness: stopping a command',
          timeoutMs: KILL_TIMEOUT_MS,
        })
        .catch(() => undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, exec.timeoutMs);
    const pulse = setInterval(() => {
      try {
        heartbeat();
      } catch {
        /* not in an activity context */
      }
    }, HEARTBEAT_MS);
    pulse.unref?.();
    const signals = [abort, exec.signal].filter((s): s is AbortSignal => s !== undefined);
    for (const signal of signals) {
      signal.addEventListener('abort', kill, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(pulse);
      for (const signal of signals) {
        signal.removeEventListener('abort', kill);
      }
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      const result: HarnessExecResult = {
        droppedBytes,
        exitCode: killing ? null : code,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
        timedOut,
      };
      // Settle only once the tagged processes are gone, so a caller that
      // reads the file a killed command was writing sees it stopped.
      void (killing ?? Promise.resolve()).then(() => resolve(result));
    });

    if (signals.some((s) => s.aborted)) {
      kill();
    }
    if (hasStdin) {
      // A command that exits without reading stdin closes the pipe under us;
      // EPIPE on the write is reported through the exit status, not thrown.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(exec.stdin);
    }
  });
}
