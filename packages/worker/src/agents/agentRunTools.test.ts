import { describe, expect, it } from 'vitest';
import {
  grantedWorkspaceToolIds,
  grantsBrowserTool,
  grantsWriteTools,
  READ_TOOL_IDS,
  selectAgentRunTools,
} from './agentRunTools.js';

describe('agent run tool grants', () => {
  it('null (an agent with no opinion about tools) grants the read tools only', () => {
    expect(grantedWorkspaceToolIds(null)).toEqual([...READ_TOOL_IDS]);
    expect(grantsWriteTools(null)).toBe(false);
    expect(grantsBrowserTool(null)).toBe(false);
  });

  it.each([
    ['an empty list', []],
    ['mcp only', ['mcp']],
    ['an unknown key', ['frobnicate']],
  ])('%s grants no workspace tool at all', (_label, keys) => {
    expect(grantedWorkspaceToolIds(keys)).toEqual([]);
    expect(grantsWriteTools(keys)).toBe(false);
    expect(grantsBrowserTool(keys)).toBe(false);
  });

  it('grants the browser only when its key is explicitly named', () => {
    expect(grantsBrowserTool(['browser'])).toBe(true);
    expect(grantsBrowserTool(['readFile', 'browser'])).toBe(true);
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
