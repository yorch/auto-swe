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
    `Command was killed (exit ${SIGKILL_EXIT_CODE}, SIGKILL), most likely because the workspace ran out of memory${limit}. ` +
    'Retrying or editing the code will not help if the command needs more memory than that. ' +
    'An administrator can raise the limit with the workspace.memory setting or WORKSPACE_MEMORY.'
  );
}
