import { describe, expect, it } from 'vitest';
import { WORKFLOW_AUTHOR_PROMPT } from '../lib/agentPrompts.js';
import {
  type AuthoringCatalog,
  buildAuthorRequestMessage,
  buildRefineRequestMessage,
  buildRepairRequestMessage,
  renderAuthoringCatalog,
  WorkflowAuthorOutputSchema,
} from './authoring.js';
import type { WorkflowSpec } from './spec.js';

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

  it('omits shell-category steps from the step list when shell is not allowed', () => {
    const steps = renderAuthoringCatalog(CATALOG).split('## Library agents')[0];
    expect(steps).toContain('executeImplementation');
    expect(steps).not.toContain('runContainerStep');
  });

  it('lists shell-category steps when shell is allowed and an image is allowlisted', () => {
    const text = renderAuthoringCatalog({
      ...CATALOG,
      allowShell: true,
      shellImages: ['node:24-alpine'],
    });
    const steps = text.split('## Library agents')[0];
    expect(steps).toContain('- runContainerStep [shell]');
  });

  it('omits shell-category steps when shell is allowed but no image is allowlisted', () => {
    const text = renderAuthoringCatalog({ ...CATALOG, allowShell: true, shellImages: [] });
    expect(text.split('## Library agents')[0]).not.toContain('runContainerStep');
    expect(text).toContain('avoid shell/containerStep nodes and `runContainerStep`');
  });

  it('tells a requester without shell not to author gate commands', () => {
    const text = renderAuthoringCatalog(CATALOG);
    expect(text).toContain('Do not set a `command` on gate steps');
    const allowed = renderAuthoringCatalog({
      ...CATALOG,
      allowShell: true,
      shellImages: ['node:24-alpine'],
    });
    expect(allowed).not.toContain('Do not set a `command` on gate steps');
  });

  it('lists allowed images + the containerStep contract when shell is permitted', () => {
    const text = renderAuthoringCatalog({
      ...CATALOG,
      allowShell: true,
      shellImages: ['node:24-alpine', 'ghcr.io/acme/sbom:1'],
    });
    expect(text).toContain('Coded / container steps: allowed');
    expect(text).toContain('CONTAINER_STEP_INPUT');
    expect(text).toContain('node:24-alpine');
    expect(text).toContain('ghcr.io/acme/sbom:1');
  });

  it('warns when shell is allowed but no images are allowlisted', () => {
    const text = renderAuthoringCatalog({ ...CATALOG, allowShell: true, shellImages: [] });
    expect(text).toContain('No images are allowlisted');
  });

  it('notes when no agents or connections are available', () => {
    const text = renderAuthoringCatalog({ agents: [], allowShell: false, mcpConnections: [] });
    expect(text).toContain('avoid `agent` nodes');
    expect(text).toContain('do not emit `mcp` nodes');
  });

  it('tells the model MCP tool names are not listed', () => {
    const text = renderAuthoringCatalog({
      agents: [],
      allowShell: false,
      mcpConnections: [{ description: null, id: 'conn-1', name: 'Jira' }],
    });
    expect(text).toContain('Tool names are not listed here');
  });
});

describe('WORKFLOW_AUTHOR_PROMPT', () => {
  it('covers every eval scorer kind and the fanOut / failure-policy fields', () => {
    for (const kind of ['gate', 'assert', 'trajectory', 'judge', 'policy', 'pii']) {
      expect(WORKFLOW_AUTHOR_PROMPT).toContain(`"kind":"${kind}"`);
    }
    for (const field of [
      'candidateRef',
      'judgeAdvisory',
      'onBranchFail',
      'pluck',
      'approverCount',
      'contextFrom',
      'storeAs',
      'onError',
    ]) {
      expect(WORKFLOW_AUTHOR_PROMPT).toContain(field);
    }
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

describe('buildRefineRequestMessage', () => {
  const BASE_SPEC: WorkflowSpec = {
    description: 'does a thing',
    entry: 'start',
    name: 'my-workflow',
    nodes: { start: { status: 'SUCCESS', type: 'terminate' } },
    schemaVersion: 1,
  };

  it('embeds the current spec, the change request, and the catalog', () => {
    const msg = buildRefineRequestMessage({
      baseSpec: BASE_SPEC,
      catalog: CATALOG,
      instruction: 'add a lint step before the terminate',
    });
    expect(msg).toContain('# CURRENT SPEC');
    expect(msg).toContain('my-workflow');
    expect(msg).toContain('# CHANGE REQUEST');
    expect(msg).toContain('add a lint step before the terminate');
    expect(msg).toContain('# CATALOG');
    // Instructs the model to return the full spec, not a diff.
    expect(msg).toContain('FULL updated spec');
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
