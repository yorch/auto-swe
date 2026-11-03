import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, policyGatedWrite, sourceHead, terminate } from './authoring/index.js';

/** Times a person may send the proposed ticket structure back for another pass. */
export const MAX_PLAN_REVISIONS = 3;

/**
 * Review a Confluence page against criteria, leave the findings on it as comments, and, when the
 * page is ready, propose an epic, tickets and sub-tasks to a person and create them in Jira.
 *
 *   read page -> review -> check the reply -> comments gate -> ready?
 *     not ready: stop. The author fixes the page and the run is started again.
 *     ready:     plan -> check the reply -> a person reviews the structure
 *                  approve:         tickets gate -> create the tickets
 *                  request changes: back to the planner with the note (up to three times)
 *                  reject / timeout: stop
 *
 * Two gates, deliberately. The person who reviews the structure decides what the tickets say; the
 * autonomy policy, which an operator may tighten or relax, decides whether creating them in the
 * tracker also needs an approval. The structure review is therefore always a person, whatever the
 * policy allows. Both writes are external, so each goes through `publishOutcome` and is
 * unreachable without the decision it records.
 *
 * The run is scoped to the Confluence page: the page is the thing read, and the tracker is named
 * separately by `trackerConnectionId` for the tickets, as `issue-to-confluence-page` does in the
 * other direction. A reply from either agent that is not the expected JSON stops the run before
 * any write: nothing a model returned is written without being checked in code first.
 */
export const CONFLUENCE_REVIEW_TO_TICKETS_SPEC: WorkflowSpec = {
  description:
    'Review a Confluence page against your criteria and leave the findings on it as comments. ' +
    'When the page is ready, propose an epic with tickets and sub-tasks, let a person review ' +
    'or send back the structure, and create the tickets in Jira after policy and approval ' +
    'gating. A page that is not ready stops after the comments: fix it and run it again.',
  entry: 'resolveWorkspace',
  name: 'confluence-review-to-tickets',
  nodes: mergeNodes(
    sourceHead({
      next: 'reviewDocument',
      provider: 'document',
      read: { pageId: { from: 'request.payload.pageId' } },
    }),
    {
      reviewDocument: {
        agentRef: 'docReviewer',
        group: 'review',
        inputs: {
          context: { default: '', from: 'request.payload.instructions' },
          criteria: { default: '', from: 'request.payload.criteria' },
          document: { from: 'nodes.readSource.output.data' },
        },
        next: 'parseReview',
        spanName: 'llm.document_review',
        title: 'Review the page',
        type: 'agent',
      },
      parseReview: {
        config: { kind: 'docReview' },
        group: 'review',
        inputs: { text: { from: 'nodes.reviewDocument.output.text' } },
        next: 'checkReview',
        step: 'parseAgentOutput',
        title: 'Check the review',
        type: 'step',
      },
      checkReview: {
        expr: 'nodes.parseReview.output.valid == true',
        group: 'review',
        onFalse: 'doneBadReview',
        onTrue: 'setCommentPayload',
        title: 'Is the review usable?',
        type: 'cond',
      },
      doneBadReview: terminate('FAILED', { group: 'review', title: 'Review unusable' }),
      setCommentPayload: {
        group: 'review',
        next: 'commentsPublishOutcome',
        title: 'Prepare the comments',
        type: 'set',
        values: {
          'context.commentPayload.comments': { from: 'nodes.parseReview.output.comments' },
          'context.commentPayload.pageId': { from: 'request.payload.pageId' },
        },
      },
    },
    policyGatedWrite({
      action: 'external_write',
      approval: {
        contextFrom: 'nodes.parseReview.output.markdown',
        description:
          'The review is ready to be left on the Confluence page as comments. Approve to post ' +
          'them, reject to discard them.',
        title: 'Approve review comments on the page',
      },
      describeFrom: 'request.payload.pageId',
      done: 'checkReady',
      group: 'review comments',
      idPrefix: 'comments',
      rejectedResult: {
        approved: { literal: false },
        pageId: { from: 'request.payload.pageId' },
        ready: { from: 'nodes.parseReview.output.ready' },
        written: { literal: false },
      },
      write: {
        inputs: {
          connectionId: { from: 'request.payload.connectionId' },
          data: { from: 'context.commentPayload' },
        },
      },
      writes: 'split',
    }),
    {
      checkReady: {
        expr: 'nodes.parseReview.output.ready == true',
        group: 'verdict',
        onFalse: 'doneNotReady',
        onTrue: 'initPlan',
        title: 'Is the page ready?',
        type: 'cond',
      },
      doneNotReady: terminate('SUCCESS', {
        group: 'verdict',
        result: {
          findings: { from: 'nodes.parseReview.output.findingCount' },
          pageId: { from: 'request.payload.pageId' },
          ready: { literal: false },
          summary: { from: 'nodes.parseReview.output.summary' },
        },
        title: 'Not ready, comments left',
      }),
      initPlan: {
        group: 'plan',
        next: 'planTickets',
        title: 'Start the planning rounds',
        type: 'set',
        values: {
          'context.planFeedback': { literal: '' },
          'context.planRevisions': { literal: 0 },
        },
      },
      planTickets: {
        agentRef: 'ticketPlanner',
        group: 'plan',
        inputs: {
          context: { default: '', from: 'request.payload.instructions' },
          document: { from: 'nodes.readSource.output.data' },
          reviewerNote: { from: 'context.planFeedback' },
          review: { from: 'nodes.parseReview.output.markdown' },
        },
        next: 'parsePlan',
        spanName: 'llm.ticket_plan',
        title: 'Propose the tickets',
        type: 'agent',
      },
      parsePlan: {
        config: { kind: 'ticketPlan' },
        group: 'plan',
        inputs: { text: { from: 'nodes.planTickets.output.text' } },
        next: 'checkPlan',
        step: 'parseAgentOutput',
        title: 'Check the plan',
        type: 'step',
      },
      checkPlan: {
        expr: 'nodes.parsePlan.output.valid == true',
        group: 'plan',
        onFalse: 'doneBadPlan',
        onTrue: 'approveStructure',
        title: 'Is the plan usable?',
        type: 'cond',
      },
      doneBadPlan: terminate('FAILED', { group: 'plan', title: 'Plan unusable' }),
      approveStructure: {
        contextFrom: 'nodes.parsePlan.output.markdown',
        description:
          'This is the proposed epic, tickets and sub-tasks for the Confluence page. Approve to ' +
          'create them in the tracker, request changes (with a note) to have the planner try ' +
          `again (up to ${MAX_PLAN_REVISIONS} times), or reject to stop without creating anything.`,
        group: 'approve structure',
        onApprove: 'setTicketPayload',
        onReject: 'doneRejected',
        onRequestChanges: 'noteStructureChanges',
        onTimeout: 'doneTimedOut',
        timeout: '72h',
        title: 'Review the proposed ticket structure',
        type: 'humanApproval',
      },
      noteStructureChanges: {
        group: 'approve structure',
        next: 'checkRevisions',
        title: 'Keep the requested changes',
        type: 'set',
        values: {
          'context.planFeedback': { from: 'nodes.approveStructure.output.comment' },
          'context.planRevisions': { expr: 'context.planRevisions + 1' },
        },
      },
      checkRevisions: {
        expr: `context.planRevisions > ${MAX_PLAN_REVISIONS}`,
        group: 'approve structure',
        onFalse: 'planTickets',
        onTrue: 'doneRevisionsExhausted',
        title: 'Out of revisions?',
        type: 'cond',
      },
      doneRevisionsExhausted: terminate('FAILED', {
        group: 'approve structure',
        title: 'Structure not agreed after the revisions',
      }),
      doneRejected: terminate('SUCCESS', {
        group: 'approve structure',
        result: { created: { literal: false }, pageId: { from: 'request.payload.pageId' } },
        title: 'Structure rejected, nothing created',
      }),
      doneTimedOut: terminate('TIMED_OUT', {
        group: 'approve structure',
        title: 'Structure review timed out',
      }),
      setTicketPayload: {
        group: 'tickets',
        next: 'ticketsPublishOutcome',
        title: 'Prepare the tickets',
        type: 'set',
        values: {
          'context.ticketPayload.epicIssueType': {
            default: '',
            from: 'request.payload.epicIssueType',
          },
          'context.ticketPayload.plan': { from: 'nodes.parsePlan.output.plan' },
          'context.ticketPayload.projectKey': { default: '', from: 'request.payload.projectKey' },
          'context.ticketPayload.storyIssueType': {
            default: '',
            from: 'request.payload.storyIssueType',
          },
          'context.ticketPayload.subtaskIssueType': {
            default: '',
            from: 'request.payload.subtaskIssueType',
          },
        },
      },
    },
    policyGatedWrite({
      action: 'external_write',
      approval: {
        contextFrom: 'nodes.parsePlan.output.markdown',
        description:
          'The approved ticket structure is ready to be created in the tracker. Approve to ' +
          'create it, reject to discard it.',
        title: 'Approve ticket creation',
      },
      describeFrom: 'request.payload.pageId',
      done: 'done',
      group: 'tickets',
      idPrefix: 'tickets',
      rejectedResult: {
        approved: { literal: false },
        created: { literal: false },
        pageId: { from: 'request.payload.pageId' },
      },
      write: {
        inputs: {
          connectionId: { from: 'request.payload.trackerConnectionId' },
          data: { from: 'context.ticketPayload' },
        },
      },
      writes: 'split',
    }),
    {
      done: terminate('SUCCESS', {
        result: {
          created: { literal: true },
          epicUrl: {
            expr: 'nodes.ticketsAutoWrite.output.reference ?? nodes.ticketsManualWrite.output.reference',
          },
          pageId: { from: 'request.payload.pageId' },
          ready: { literal: true },
          ticketUrls: {
            expr: 'nodes.ticketsAutoWrite.output.references ?? nodes.ticketsManualWrite.output.references',
          },
        },
        title: 'Tickets created',
      }),
    }
  ),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
