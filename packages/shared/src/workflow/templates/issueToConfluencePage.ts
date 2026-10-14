import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, policyGatedWrite, sourceHead, terminate } from './authoring/index.js';

/**
 * Read a Jira or Linear issue, draft a page with the content writer, and create
 * or update it in Confluence.
 *
 * The run is scoped to the issue tracker, not to the page: an issue is the thing
 * being read, and the Confluence connection is named separately by
 * `docConnectionId` for the write. Reading and writing through two connections
 * in one run is the generic case — each `readSource`/`writeOutcome` node names
 * its own `connectionId` — so nothing about the workspace provider has to
 * describe the write target.
 *
 * `targetPageId` switches the write from create to update. Both halves are gated
 * by the autonomy policy, because both are an external write.
 */
export const ISSUE_TO_CONFLUENCE_PAGE_SPEC: WorkflowSpec = {
  description:
    'Read a Jira or Linear issue, draft a Confluence page with the content writer, and create that page — or rewrite the one the request names — after policy/approval gating.',
  entry: 'resolveWorkspace',
  name: 'issue-to-confluence-page',
  nodes: mergeNodes(
    sourceHead({
      next: 'draftPage',
      provider: 'issue_tracker',
      read: { issueId: { from: 'request.payload.issueId' } },
    }),
    {
      draftPage: {
        agentRef: 'contentWriter',
        group: 'draft',
        inputs: {
          instructions: { from: 'request.payload.instructions' },
          issue: { from: 'nodes.readSource.output.data' },
          targetPageId: { from: 'request.payload.targetPageId' },
        },
        next: 'publishOutcome',
        spanName: 'llm.confluence_page_draft',
        title: 'Draft the page',
        type: 'agent',
      },
    },
    policyGatedWrite({
      action: 'external_write',
      approval: {
        contextFrom: 'nodes.draftPage.output.text',
        description:
          'A Confluence page draft is ready. Approve to publish it, reject to discard it.',
        title: 'Approve Confluence page write',
      },
      describeFrom: 'request.payload.issueId',
      rejectedResult: {
        approved: { literal: false },
        issueId: { from: 'request.payload.issueId' },
        written: { literal: false },
      },
      write: {
        inputs: {
          bodyText: { from: 'nodes.draftPage.output.text' },
          connectionId: { from: 'request.payload.docConnectionId' },
          // The issue's own title, used when the request names none. A form submits
          // an untouched optional field as an empty string, and no binding can
          // express "the first non-empty of these" — the evaluator's `||` yields a
          // boolean and `??` only covers null — so the choice is made in the write
          // activity, which is told both.
          fallbackTitle: { from: 'nodes.readSource.output.data.title' },
          spaceKey: { from: 'request.payload.spaceKey' },
          targetPageId: { from: 'request.payload.targetPageId' },
          title: { from: 'request.payload.title' },
          // Carried into the update so a retry re-sends the same precondition.
          version: { from: 'request.payload.version' },
        },
      },
      writes: 'split',
    }),
    {
      done: terminate('SUCCESS', {
        result: {
          approved: { literal: true },
          issueId: { from: 'request.payload.issueId' },
          // The split writes name their nodes autoWrite/manualWrite; one of them ran.
          pageUrl: {
            expr: 'nodes.autoWrite.output.reference ?? nodes.manualWrite.output.reference',
          },
          targetPageId: { from: 'request.payload.targetPageId' },
        },
        title: 'Page published',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
