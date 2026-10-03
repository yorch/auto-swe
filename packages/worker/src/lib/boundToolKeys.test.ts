import { describe, expect, it } from 'vitest';
import { boundToolKeys } from './boundToolKeys.js';

describe('boundToolKeys', () => {
  it('names only the bound tools a self-recording source still supplies', () => {
    const mcpSearch = { id: 'mcp' };
    const specSearch = { id: 'spec' };
    const readFile = { id: 'ws' };
    // `search` collided and the spec tool won it, so it is not self-recording.
    const bound = { mcp_only: mcpSearch, readFile, search: specSearch };
    const keys = boundToolKeys(bound, { readFile }, { mcp_only: mcpSearch, search: mcpSearch });
    expect([...keys].sort()).toEqual(['mcp_only', 'readFile']);
  });

  it('names nothing when no source is supplied', () => {
    expect(boundToolKeys({ lookup: {} }, undefined).size).toBe(0);
  });
});
