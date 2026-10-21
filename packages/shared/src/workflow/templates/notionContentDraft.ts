import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, policyGatedWrite, sourceHead, terminate } from './authoring/index.js';

/**
 * Notion content draft workflow.
 *
 * Reads a source Notion page, asks the content-writer agent to draft a short
 * update from the source material and optional instructions, then appends the
 * draft as a paragraph block to a target Notion page.
 *
 * This is the first non-git template: it demonstrates the generic
 * resolveWorkspace → readSource → agent → writeOutcome pipeline for a document
 * workspace.
 *
 * The write is policy-gated like every other shipped template that writes: the
 * appended paragraph lands in the operator's own Notion, so the class is
 * `internal_write`, and `publishOutcome` records the decision the audit log and
 * any later policy edit are held to. Skipping the step is not neutral — a run
 * that records no decision is not gated at all.
 */
export const NOTION_CONTENT_DRAFT_SPEC: WorkflowSpec = {
  description:
    'Read a Notion source page, draft a short update with the content writer, and append it to a target Notion page.',
  entry: 'resolveWorkspace',
  name: 'notion-content-draft',
  nodes: mergeNodes(
    sourceHead({
      next: 'draftContent',
      provider: 'document',
      read: { pageId: { from: 'request.payload.sourcePageId' } },
    }),
    {
      draftContent: {
        agentRef: 'contentWriter',
        group: 'draft',
        inputs: {
          instructions: { default: '', from: 'request.payload.instructions' },
          source: { from: 'nodes.readSource.output.data' },
          targetPageId: { from: 'request.payload.targetPageId' },
        },
        next: 'publishOutcome',
        spanName: 'llm.notion_draft',
        title: 'Draft the update',
        type: 'agent',
      },
    },
    policyGatedWrite({
      action: 'internal_write',
      approval: {
        contextFrom: 'nodes.draftContent.output.text',
        description:
          'Approve appending the draft to the target Notion page, or reject to discard it.',
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
          text: { from: 'nodes.draftContent.output.text' },
        },
      },
      writes: 'single',
    }),
    {
      done: terminate('SUCCESS', {
        group: 'write',
        result: {
          targetPageId: { from: 'request.payload.targetPageId' },
          text: { from: 'nodes.draftContent.output.text' },
        },
        title: 'Done',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
