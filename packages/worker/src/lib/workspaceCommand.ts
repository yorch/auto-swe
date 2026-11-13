import type { Workspace } from '../activities/workspace.js';
import { maskCredentialShapes } from './redactToken.js';

export function workspaceLogTail(
  workspace: Workspace | undefined,
  text: string,
  limit = 4000
): string {
  return maskCredentialShapes(workspace?.redact?.(text) ?? text).slice(-limit);
}

export async function captureWorkspaceCommand(
  workspace: Workspace,
  command: string,
  timeoutMs?: number
) {
  const result = await workspace.execCapture(command, { timeoutMs });
  return {
    ...result,
    logTail: workspaceLogTail(
      workspace,
      `${result.stdout}\n${result.stderr}${result.signal ? `\nStopped by ${result.signal}` : ''}`.trim()
    ),
  };
}
