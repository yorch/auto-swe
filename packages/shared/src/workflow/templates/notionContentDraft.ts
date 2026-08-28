import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

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
 */
export const NOTION_CONTENT_DRAFT_SPEC: WorkflowSpec = {
  description:
    'Read a Notion source page, draft a short update with the content writer, and append it to a target Notion page.',
  entry: 'resolveWorkspace',
  name: 'notion-content-draft',
  nodes: {
    done: {
      result: {
        targetPageId: { from: 'request.payload.targetPageId' },
        text: { from: 'nodes.draftContent.output.text' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    draftContent: {
      agentRef: 'contentWriter',
      inputs: {
        instructions: { default: '', from: 'request.payload.instructions' },
        source: { from: 'nodes.readSource.output.data' },
        targetPageId: { from: 'request.payload.targetPageId' },
      },
      next: 'writeOutcome',
      spanName: 'llm.notion_draft',
      type: 'agent',
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
        text: { from: 'nodes.draftContent.output.text' },
      },
      next: 'done',
      step: 'writeOutcome',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
