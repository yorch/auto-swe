import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { policyGatedWrite, sourceHead, terminate } from './authoring/index.js';

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
    ...sourceHead({
      next: 'draftContent',
      provider: 'document',
      read: { pageId: { from: 'request.payload.sourcePageId' } },
    }),
    draftContent: {
      agentRef: 'contentWriter',
      group: 'draft',
      inputs: {
        instructions: { default: '', from: 'request.payload.instructions' },
        source: { from: 'nodes.readSource.output.data' },
      },
      next: 'brandReview',
      spanName: 'llm.content_draft',
      title: 'Draft the update',
      type: 'agent',
    },
    brandReview: {
      agentRef: 'brandReviewer',
      group: 'draft',
      inputs: {
        draft: { from: 'nodes.draftContent.output.text' },
        instructions: { default: '', from: 'request.payload.instructions' },
      },
      next: 'publishOutcome',
      spanName: 'llm.brand_review',
      title: 'Review for brand voice',
      type: 'agent',
    },
    ...policyGatedWrite({
      action: 'internal_write',
      approval: {
        contextFrom: 'nodes.brandReview.output.text',
        description:
          'Approve appending the reviewed draft to the target Notion page, or reject to discard it.',
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
          text: { from: 'nodes.brandReview.output.text' },
        },
      },
      writes: 'single',
    }),
    done: terminate('SUCCESS', {
      result: {
        targetPageId: { from: 'request.payload.targetPageId' },
        text: { from: 'nodes.brandReview.output.text' },
      },
      title: 'Done',
    }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
