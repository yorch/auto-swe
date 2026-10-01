import { IMPLEMENTER_TOOL_IDS } from '@auto-swe/shared/workflow/stepRegistry';

/**
 * Which workspace tools an agent RUN grants, from the resolved Agent's `toolKeys`.
 *
 * This is deliberately not the implementer's rule. `createImplementerAgent`
 * reads `null`, `[]` and "no workspace key listed" (`['mcp']`) all as "every
 * tool", and `selectTools` reads `null` as "every candidate". Applied to an
 * arbitrary library agent, either would hand `bash` and `writeFile` to every
 * agent that has no opinion about tools: `contentWriter`, `supportResponder`
 * and the reviewer personas all seed with `toolKeys: null`, and an agent run
 * can publish what the agent writes.
 *
 * So `toolKeys` is an allowlist, and `null` ("no opinion") is the only value
 * that defaults:
 *
 *  - `null` -> the read tools only (`readFile`, `listDirectory`);
 *  - a list -> exactly the workspace tools it NAMES. `[]` grants none, and
 *    `['mcp']` grants no workspace tool (MCP only); naming `bash` alone grants
 *    `bash` alone, not the read tools beside it.
 *
 * This is also what `resolveAgentSpec` does when it intersects the offered
 * tools with `toolKeys`, so the two steps agree and nothing is granted that the
 * list does not name. MCP is a separate decision (`isMcpToolEnabled`).
 */
export const READ_TOOL_IDS = ['readFile', 'listDirectory'] as const;
export const WRITE_TOOL_IDS = ['writeFile', 'bash'] as const;

export type WorkspaceToolId = (typeof IMPLEMENTER_TOOL_IDS)[number];

export function grantedWorkspaceToolIds(toolKeys: readonly string[] | null): WorkspaceToolId[] {
  if (toolKeys === null) {
    return [...READ_TOOL_IDS];
  }
  return IMPLEMENTER_TOOL_IDS.filter((id) => toolKeys.includes(id));
}

/** Pick the granted subset out of a built tool set. */
export function selectAgentRunTools<T extends Record<WorkspaceToolId, unknown>>(
  built: T,
  toolKeys: readonly string[] | null
): Partial<T> {
  const picked: Partial<T> = {};
  for (const id of grantedWorkspaceToolIds(toolKeys)) {
    picked[id] = built[id];
  }
  return picked;
}

/** True when the grant includes a tool that can change the workspace. */
export function grantsWriteTools(toolKeys: readonly string[] | null): boolean {
  return grantedWorkspaceToolIds(toolKeys).some((id) =>
    (WRITE_TOOL_IDS as readonly string[]).includes(id)
  );
}
