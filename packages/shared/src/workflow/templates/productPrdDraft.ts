import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, policyGatedWrite, sourceHead, terminate } from './authoring/index.js';

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
  nodes: mergeNodes(
    sourceHead({
      afterResolve: 'checkSource',
      next: 'analyzeBrief',
      provider: 'document',
      read: { pageId: { from: 'request.payload.sourcePageId' } },
    }),
    {
      // The source page is optional: with none, the brief alone is analysed.
      checkSource: {
        expr: 'request.payload.sourcePageId == null',
        group: 'read source',
        onFalse: 'readSource',
        onTrue: 'analyzeBrief',
        title: 'Has a source page?',
        type: 'cond',
      },
      analyzeBrief: {
        agentRef: 'productAnalyst',
        group: 'draft',
        inputs: {
          brief: { from: 'request.payload.brief' },
          instructions: { default: '', from: 'request.payload.instructions' },
          sourceMaterial: { default: '', from: 'nodes.readSource.output.data' },
        },
        next: 'draftPrd',
        spanName: 'llm.product_analysis',
        title: 'Analyse the brief',
        type: 'agent',
      },
      draftPrd: {
        agentRef: 'prdWriter',
        group: 'draft',
        inputs: {
          analysis: { from: 'nodes.analyzeBrief.output.text' },
          instructions: { default: '', from: 'request.payload.instructions' },
        },
        next: 'publishOutcome',
        spanName: 'llm.prd_draft',
        title: 'Draft the PRD',
        type: 'agent',
      },
    },
    policyGatedWrite({
      action: 'internal_write',
      approval: {
        contextFrom: 'nodes.draftPrd.output.text',
        description: 'Approve writing the drafted PRD to the target page, or reject to discard it.',
        title: 'Approve write',
      },
      describeFrom: 'request.payload.instructions',
      rejectedResult: {
        approved: { literal: false },
        targetPageId: { from: 'request.payload.targetPageId' },
        written: { literal: false },
      },
      write: {
        config: {},
        inputs: {
          connectionId: { from: 'request.payload.connectionId' },
          pageId: { from: 'request.payload.targetPageId' },
          text: { from: 'nodes.draftPrd.output.text' },
        },
      },
      writes: 'single',
    }),
    {
      done: terminate('SUCCESS', {
        result: {
          targetPageId: { from: 'request.payload.targetPageId' },
          text: { from: 'nodes.draftPrd.output.text' },
        },
        title: 'Done',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
