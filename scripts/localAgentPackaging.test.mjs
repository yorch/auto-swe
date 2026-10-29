import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerReadTools, registerWriteTools } from '../packages/gateway/src/lib/mcp/tools.js';

const guides = [
  '../integrations/claude-code/skills/delegate/SKILL.md',
  '../integrations/codex/AGENTS.md',
];

function referencedTools(markdown) {
  return [...markdown.matchAll(/`auto-swe\.([a-z][a-z0-9_]*)`/g)].map((match) => match[1]);
}

function registeredTools() {
  const names = new Set();
  const server = {
    registerTool: (name) => names.add(name),
  };
  const deps = { dashboardOrigin: 'https://auto-swe.example.com' };
  const caller = {
    clientIp: '127.0.0.1',
    scopes: ['mcp:read', 'mcp:write'],
    token: 'unused',
    userId: 'unused',
  };
  registerReadTools(server, deps, caller);
  registerWriteTools(server, deps, caller);
  return names;
}

describe('local-agent MCP tool references', () => {
  const registered = registeredTools();

  it.each(guides)('%s references only tools the server registers', (path) => {
    const references = referencedTools(readFileSync(new URL(path, import.meta.url), 'utf8'));
    expect(references.length).toBeGreaterThan(0);
    expect(references.filter((name) => !registered.has(name))).toEqual([]);
  });

  it('extracts qualified references without treating outcome fields or delivery modes as tools', () => {
    expect(referencedTools('`auto-swe.get_run` `draft_pr` `failure.type`')).toEqual(['get_run']);
    expect(referencedTools('')).toEqual([]);
    expect(
      referencedTools('`auto-swe.renamed_tool`').filter((name) => !registered.has(name))
    ).toEqual(['renamed_tool']);
  });
});
