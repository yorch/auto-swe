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

export const EXEC_OPTS: ExecSyncOptions = {
  encoding: 'utf-8' as BufferEncoding,
  maxBuffer: 10 * 1024 * 1024,
  timeout: 120_000,
};

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
