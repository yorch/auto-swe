import { describe, expect, it } from 'vitest';
import {
  grantedWorkspaceToolIds,
  grantsWriteTools,
  READ_TOOL_IDS,
  selectAgentRunTools,
} from './agentRunTools.js';

describe('agent run tool grants', () => {
  it.each([
    ['null (an agent with no opinion about tools)', null],
    ['an empty list', []],
    ['mcp only', ['mcp']],
    ['an unknown key', ['frobnicate']],
  ])('%s grants the read tools only, never bash or writeFile', (_label, keys) => {
    expect(grantedWorkspaceToolIds(keys as string[] | null)).toEqual([...READ_TOOL_IDS]);
    expect(grantsWriteTools(keys as string[] | null)).toBe(false);
  });

  it('grants a write tool only when it is named', () => {
    expect(grantedWorkspaceToolIds(['writeFile'])).toEqual(['writeFile']);
    expect(grantedWorkspaceToolIds(['bash', 'readFile'])).toEqual(['readFile', 'bash']);
    expect(grantsWriteTools(['bash'])).toBe(true);
    expect(grantsWriteTools(['readFile', 'listDirectory'])).toBe(false);
  });

  it('does not add the read tools beside a named write tool', () => {
    expect(grantedWorkspaceToolIds(['bash'])).toEqual(['bash']);
  });

  it('picks exactly the granted tools from a built set', () => {
    const built = { bash: 1, listDirectory: 2, readFile: 3, writeFile: 4 };
    expect(selectAgentRunTools(built, null)).toEqual({ listDirectory: 2, readFile: 3 });
    expect(selectAgentRunTools(built, ['mcp', 'writeFile'])).toEqual({ writeFile: 4 });
    expect(selectAgentRunTools(built, ['bash', 'writeFile', 'readFile', 'listDirectory'])).toEqual(
      built
    );
  });
});
