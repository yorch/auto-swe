import { describe, expect, it } from 'vitest';
import {
  type AuthoringCatalog,
  buildAuthorRequestMessage,
  buildRepairRequestMessage,
  renderAuthoringCatalog,
  WorkflowAuthorOutputSchema,
} from './authoring.js';

const CATALOG: AuthoringCatalog = {
  agents: [{ description: 'Writes code.', key: 'implementer', name: 'Implementer' }],
  allowShell: false,
  mcpConnections: [{ description: null, id: 'conn-1', name: 'Jira' }],
};

describe('renderAuthoringCatalog', () => {
  it('lists registered steps, agents, and mcp connections', () => {
    const text = renderAuthoringCatalog(CATALOG);
    // A known registered step name appears.
    expect(text).toContain('executeImplementation');
    expect(text).toContain('implementer (Implementer)');
    expect(text).toContain('conn-1 (Jira)');
  });

  it('flags shell as not allowed by default', () => {
    expect(renderAuthoringCatalog(CATALOG)).toContain('Shell: NOT allowed');
  });

  it('flags shell as allowed when permitted', () => {
    expect(renderAuthoringCatalog({ ...CATALOG, allowShell: true })).toContain('Shell: allowed');
  });

  it('notes when no agents or connections are available', () => {
    const text = renderAuthoringCatalog({ agents: [], allowShell: false, mcpConnections: [] });
    expect(text).toContain('avoid `agent` nodes');
    expect(text).toContain('do not emit `mcp` nodes');
  });
});

describe('buildAuthorRequestMessage', () => {
  it('embeds the intent and the catalog', () => {
    const msg = buildAuthorRequestMessage('Open a PR after review', CATALOG);
    expect(msg).toContain('# REQUEST');
    expect(msg).toContain('Open a PR after review');
    expect(msg).toContain('# CATALOG');
  });
});

describe('buildRepairRequestMessage', () => {
  it('includes the errors, the prior attempt, and the intent', () => {
    const msg = buildRepairRequestMessage({
      catalog: CATALOG,
      errors: ["entry node 'foo' is not in nodes map"],
      intent: 'Do a thing',
      previousSpecJson: '{"schemaVersion":1}',
    });
    expect(msg).toContain('entry node');
    expect(msg).toContain('PREVIOUS ATTEMPT');
    expect(msg).toContain('Do a thing');
  });
});

describe('WorkflowAuthorOutputSchema', () => {
  it('requires specJson and defaults summary to empty', () => {
    const parsed = WorkflowAuthorOutputSchema.parse({ specJson: '{}' });
    expect(parsed.summary).toBe('');
  });

  it('rejects missing specJson', () => {
    expect(() => WorkflowAuthorOutputSchema.parse({ summary: 'x' })).toThrow();
  });
});
