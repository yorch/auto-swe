import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Product PRD draft workflow.
 *
 * Reads an optional source Notion page, analyzes a problem brief with the
 * product analyst, drafts a lightweight PRD with acceptance criteria using the
 * PRD writer, and appends the result to a target Notion page.
 */
export const PRODUCT_PRD_DRAFT_SPEC: WorkflowSpec = {
  description:
    'Analyze a product brief and draft a focused PRD with acceptance criteria, then append it to a Notion page.',
  entry: 'resolveWorkspace',
  name: 'product-prd-draft',
  nodes: {
    analyzeBrief: {
      agentRef: 'productAnalyst',
      inputs: {
        brief: { from: 'request.payload.brief' },
        instructions: { default: '', from: 'request.payload.instructions' },
        sourceMaterial: { default: '', from: 'nodes.readSource.output.data' },
      },
      next: 'draftPrd',
      spanName: 'llm.product_analysis',
      type: 'agent',
    },
    checkSource: {
      expr: 'request.payload.sourcePageId == null',
      onFalse: 'readSource',
      onTrue: 'analyzeBrief',
      type: 'cond',
    },
    done: {
      result: {
        targetPageId: { from: 'request.payload.targetPageId' },
        text: { from: 'nodes.draftPrd.output.text' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    draftPrd: {
      agentRef: 'prdWriter',
      inputs: {
        analysis: { from: 'nodes.analyzeBrief.output.text' },
        instructions: { default: '', from: 'request.payload.instructions' },
      },
      next: 'publishOutcome',
      spanName: 'llm.prd_draft',
      type: 'agent',
    },
    publishOutcome: {
      config: { action: 'internal_write' },
      inputs: {
        description: { from: 'request.payload.instructions' },
      },
      next: 'writeOutcome',
      step: 'publishOutcome',
      type: 'step',
    },
    readSource: {
      config: {},
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        pageId: { from: 'request.payload.sourcePageId' },
      },
      next: 'analyzeBrief',
      step: 'readSource',
      type: 'step',
    },
    resolveWorkspace: {
      config: { workspaceProvider: 'document' },
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
      },
      next: 'checkSource',
      step: 'resolveWorkspace',
      type: 'step',
    },
    writeOutcome: {
      config: {},
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        pageId: { from: 'request.payload.targetPageId' },
        text: { from: 'nodes.draftPrd.output.text' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
