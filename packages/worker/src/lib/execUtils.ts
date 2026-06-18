/**
 * Shared helpers for `child_process` callouts in worker activities.
 *
 * `EXEC_OPTS` is the canonical synchronous-exec config (10MB buffer, 2-minute
 * default timeout, utf-8 encoding) used by every activity that shells out to
 * docker. `parseSpawnSyncResult` normalizes the three failure shapes that
 * `spawnSync` returns (clean exit, timeout/signal kill, spawn error) into a
 * single `{exitCode, stdout, stderr, signal?}` envelope so call sites can
 * react with one branch instead of three.
 */

import type { ExecSyncOptions, SpawnSyncReturns } from 'node:child_process';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { heartbeat } from '@temporalio/activity';

export const EXEC_OPTS: ExecSyncOptions = {
  encoding: 'utf-8' as BufferEncoding,
  maxBuffer: 10 * 1024 * 1024,
  timeout: 120_000,
};

const execAsyncRaw = promisify(exec);

/** How often to pump a Temporal heartbeat while a child process runs. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Pump Temporal heartbeats while awaiting a child process. Long-running
 * commands (test suites, builds) used to run through execSync, which blocked
 * the worker event loop and starved heartbeats for every concurrent activity.
 * heartbeat() throws outside an activity context (e.g. unit tests) — swallow.
 */
export async function withHeartbeat<T>(label: string, work: Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    try {
      heartbeat(label);
    } catch {
      /* not in an activity context */
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't let the pump keep the process alive.
  timer.unref?.();
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Async drop-in for `execSync(command, EXEC_OPTS)`: resolves with stdout,
 * rejects on non-zero exit with an error carrying `.stdout`/`.stderr`
 * (same shape execSync errors have, so `getExecErrorStdout` keeps working).
 * Heartbeats are pumped while the command runs.
 */
export async function execShellAsync(
  command: string,
  options?: { timeoutMs?: number; heartbeatLabel?: string }
): Promise<string> {
  const { stdout } = await withHeartbeat(
    options?.heartbeatLabel ?? 'exec',
    execAsyncRaw(command, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: options?.timeoutMs ?? 120_000,
    })
  );
  return stdout;
}

/**
 * Async equivalent of `spawnSync(file, args, …)` + `parseSpawnSyncResult`:
 * captures stdout/stderr/exitCode without throwing on non-zero exits, kills
 * the child on timeout (exitCode 124, signal SIGTERM), and reports spawn
 * failures as exitCode 127. Heartbeats are pumped while the command runs.
 */
export function spawnCaptureAsync(
  file: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    maxBuffer?: number;
    heartbeatLabel?: string;
    /**
     * Invoked once per complete newline-terminated stdout line as it arrives
     * (the trailing partial line is flushed on close). Enables streaming
     * transports (e.g. containerStep NDJSON) to react to output incrementally
     * while stdout is still also buffered into the final result.
     */
    onStdoutLine?: (line: string) => void;
  }
): Promise<CapturedResult> {
  const timeoutMs = options?.timeoutMs ?? 600_000;
  const maxBuffer = options?.maxBuffer ?? 10 * 1024 * 1024;
  const onStdoutLine = options?.onStdoutLine;

  const work = new Promise<CapturedResult>((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timedOut = false;
    let settled = false;

    const settle = (result: CapturedResult) => {
      if (settled) {
        return;
      }
      settled = true;
      // Flush any trailing partial line (output not newline-terminated).
      if (onStdoutLine && lineBuf.length > 0) {
        emitLine(lineBuf);
        lineBuf = '';
      }
      clearTimeout(killTimer);
      resolve(result);
    };

    // Guard the consumer callback: a throwing line handler must not crash the
    // child's data pump or leave the promise unsettled.
    const emitLine = (line: string) => {
      try {
        onStdoutLine?.(line);
      } catch {
        /* consumer error is non-fatal to capture */
      }
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    killTimer.unref?.();

    const cap = (current: string, chunk: Buffer): string =>
      current.length >= maxBuffer ? current : current + chunk.toString('utf-8');
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = cap(stdout, chunk);
      if (onStdoutLine) {
        lineBuf += chunk.toString('utf-8');
        let nl = lineBuf.indexOf('\n');
        while (nl !== -1) {
          emitLine(lineBuf.slice(0, nl));
          lineBuf = lineBuf.slice(nl + 1);
          nl = lineBuf.indexOf('\n');
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = cap(stderr, chunk);
    });
    // 'close' is not guaranteed after a spawn failure — settle on 'error' directly.
    child.on('error', (err) => {
      settle({
        exitCode: 127,
        signal: 'SPAWN_ERROR',
        stderr: `${stderr}\n${err.name}: ${err.message}`.trim(),
        stdout,
      });
    });
    child.on('close', (code, signal) => {
      if (timedOut) {
        settle({ exitCode: 124, signal: signal ?? 'SIGTERM', stderr, stdout });
        return;
      }
      settle({
        exitCode: code ?? 0,
        stderr,
        stdout,
        ...(signal ? { signal } : {}),
      });
    });
  });

  return withHeartbeat(options?.heartbeatLabel ?? 'exec', work);
}

export interface CapturedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
}

/**
 * Three failure shapes to disambiguate:
 *   - spawn error (docker not on PATH): result.error set, status null, signal null
 *   - timeout (Node killed the child): result.error set with ETIMEDOUT, signal SIGTERM
 *   - clean exit (incl. non-zero): result.status is a number
 *
 * Convention: 124 == timeout (coreutils), 127 == spawn failure ("command not found").
 */
export function parseSpawnSyncResult(result: SpawnSyncReturns<string>): CapturedResult {
  const stderr = result.stderr ?? '';
  if (typeof result.status === 'number') {
    return {
      exitCode: result.status,
      stderr,
      stdout: result.stdout ?? '',
      ...(result.signal ? { signal: result.signal } : {}),
    };
  }
  const errMsg = result.error ? `${result.error.name}: ${result.error.message}` : '';
  const combined = errMsg ? `${stderr}\n${errMsg}`.trim() : stderr;
  const isTimeout = !!result.signal || /ETIMEDOUT/.test(errMsg);
  return {
    exitCode: isTimeout ? 124 : 127,
    signal: result.signal ?? (isTimeout ? 'SIGTERM' : 'SPAWN_ERROR'),
    stderr: combined,
    stdout: result.stdout ?? '',
  };
}
