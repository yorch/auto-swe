/** Exit status of a process ended by SIGKILL (128 + 9), which is how the kernel's OOM killer ends one. */
const SIGKILL_EXIT_CODE = 137;

/**
 * The note appended to a command's stderr when it was most likely killed because the workspace ran
 * out of memory, or null for any other result.
 *
 * Exit 137 is a SIGKILL, and the out-of-memory killer is by far its commonest source inside a
 * memory-capped workspace, but nothing here confirms it: a `kill -9`, a `timeout -s KILL` or a
 * container removed mid-command look the same, so the text says "most likely". A `signal` on the
 * result belongs to the local `docker`/`kubectl` client (a timeout or a failed spawn), not to the
 * command, so it is never read as a memory kill. `memory` is the cap the workspace was created
 * with; it is omitted when unknown rather than guessed.
 */
export function describeWorkspaceOom(
  result: { exitCode: number; signal?: string },
  memory?: string
): string | null {
  if (result.exitCode !== SIGKILL_EXIT_CODE || result.signal) {
    return null;
  }
  const limit = memory ? ` (limit ${memory})` : '';
  return (
    `[auto-swe] Command was killed (exit ${SIGKILL_EXIT_CODE}, SIGKILL), most likely because the workspace ran out of memory${limit}. ` +
    'Retrying or editing the code will not help if the command needs more memory than that. ' +
    'An administrator can raise the limit with the workspace.memory setting or WORKSPACE_MEMORY.'
  );
}

/**
 * A captured result with the memory-kill note added, or the result itself for any other exit.
 * The note goes on stderr when that stream has content; on an empty stderr it goes on stdout
 * instead, because the gate summary reads `stderr || stdout` and a note on an empty stderr would
 * hide the output that shows what was running when the command was killed.
 */
export function withWorkspaceOomNote<
  T extends { exitCode: number; signal?: string; stdout: string; stderr: string },
>(result: T, memory?: string): T {
  const oom = describeWorkspaceOom(result, memory);
  if (!oom) {
    return result;
  }
  return result.stderr.trim() === ''
    ? { ...result, stdout: `${result.stdout}\n${oom}`.trim() }
    : { ...result, stderr: `${result.stderr}\n${oom}`.trim() };
}

/**
 * Appends the memory-kill note to the message of an error a throwing exec rejected with (`code` is
 * the exit status, as `execShellAsync` and the Kubernetes driver set it). The message keeps its
 * prefix and every other field. An error the local client was killed for (`killed`, `signal`) is
 * left alone, as is anything that is not an exit 137.
 */
export function withWorkspaceOomNoteOnError<E>(error: E, memory?: string): E {
  if (!(error instanceof Error)) {
    return error;
  }
  const fields = error as Error & { code?: unknown; signal?: unknown; killed?: unknown };
  if (typeof fields.code !== 'number' || fields.killed === true) {
    return error;
  }
  const oom = describeWorkspaceOom(
    {
      exitCode: fields.code,
      ...(typeof fields.signal === 'string' ? { signal: fields.signal } : {}),
    },
    memory
  );
  if (oom) {
    error.message = `${error.message}\n${oom}`;
  }
  return error;
}
