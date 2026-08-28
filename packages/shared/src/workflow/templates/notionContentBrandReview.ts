import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Notion content draft with brand review workflow.
 *
 * Reads a source Notion page, drafts an update with the content writer, reviews it
 * for brand voice and clarity with the brand reviewer, and appends the final draft
 * to a target Notion page.
 */
export const NOTION_CONTENT_BRAND_REVIEW_SPEC: WorkflowSpec = {
  description:
    'Read a Notion page, draft an update, review it for brand voice and clarity, and append the result to a target Notion page.',
  entry: 'resolveWorkspace',
  name: 'notion-content-brand-review',
  nodes: {
    brandReview: {
      agentRef: 'brandReviewer',
      inputs: {
        draft: { from: 'nodes.draftContent.output.text' },
        instructions: { default: '', from: 'request.payload.instructions' },
      },
      next: 'publishOutcome',
      spanName: 'llm.brand_review',
      type: 'agent',
    },
    done: {
      result: {
        targetPageId: { from: 'request.payload.targetPageId' },
        text: { from: 'nodes.brandReview.output.text' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    draftContent: {
      agentRef: 'contentWriter',
      inputs: {
        instructions: { default: '', from: 'request.payload.instructions' },
        source: { from: 'nodes.readSource.output.data' },
      },
      next: 'brandReview',
      spanName: 'llm.content_draft',
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
      next: 'draftContent',
      step: 'readSource',
      type: 'step',
    },
    resolveWorkspace: {
      config: { workspaceProvider: 'document' },
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
      },
      next: 'readSource',
      step: 'resolveWorkspace',
      type: 'step',
    },
    writeOutcome: {
      config: {},
      inputs: {
        connectionId: { from: 'request.payload.connectionId' },
        pageId: { from: 'request.payload.targetPageId' },
        text: { from: 'nodes.brandReview.output.text' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
