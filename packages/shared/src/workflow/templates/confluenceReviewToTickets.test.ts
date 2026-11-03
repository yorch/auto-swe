import { describe, expect, it } from 'vitest';
import type { Context } from '../expr.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import { WorkflowSpecSchema } from '../spec.js';
import {
  MAX_PLAN_REVISIONS,
  CONFLUENCE_REVIEW_TO_TICKETS_SPEC as spec,
} from './confluenceReviewToTickets.js';

const PLAN = {
  epic: { description: 'd', title: 'Epic' },
  rationale: 'r',
  tickets: [{ description: 'd', title: 'T' }],
};

interface Scenario {
  /** What the review parse step reports. */
  review?: Record<string, unknown>;
  /** What each planning round's parse step reports, in order; the last repeats. */
  plans?: Array<Record<string, unknown>>;
  /** Policy decision for both writes. */
  decision?: 'auto' | 'require_approval';
  /** Answers to the human gates, by signal name, in order. */
  signals?: Record<string, unknown[]>;
}

const READY_REVIEW = {
  comments: [{ body: 'Automated review: ready.', quote: '' }],
  findingCount: 0,
  markdown: '## Review: ready',
  ready: true,
  summary: 'Good',
  valid: true,
};

async function run(scenario: Scenario) {
  const calls: Array<{ nodeId: string; step: string; inputs: Record<string, unknown> }> = [];
  const signals = Object.fromEntries(
    Object.entries(scenario.signals ?? {}).map(([k, v]) => [k, [...v]])
  );
  let planRound = 0;
  const dispatcher: Dispatcher = {
    async dispatchStep({ nodeId, step, inputs }) {
      calls.push({ inputs, nodeId, step });
      switch (nodeId) {
        case 'resolveWorkspace':
          return {};
        case 'readSource':
          return { data: { bodyText: 'Goals ...', title: 'Spec' } };
        case 'reviewDocument':
        case 'planTickets':
          return { text: 'agent text' };
        case 'parseReview':
          return scenario.review ?? READY_REVIEW;
        case 'parsePlan': {
          const plans = scenario.plans ?? [{ markdown: '## Epic', plan: PLAN, valid: true }];
          return plans[Math.min(planRound++, plans.length - 1)];
        }
        case 'commentsPublishOutcome':
        case 'ticketsPublishOutcome':
          return { approverCount: 1, decision: scenario.decision ?? 'auto' };
        case 'commentsAutoWrite':
        case 'commentsManualWrite':
          return { ok: true, reference: 'https://wiki/pages/9' };
        case 'ticketsAutoWrite':
        case 'ticketsManualWrite':
          return {
            ok: true,
            reference: 'https://jira/browse/ENG-1',
            references: ['https://jira/browse/ENG-1', 'https://jira/browse/ENG-2'],
          };
        default:
          return {};
      }
    },
    async notifyHumanStep() {},
    async recordStep() {},
    async resolveHumanStep() {},
    async waitSignal(name) {
      return signals[name]?.shift();
    },
  };
  const ctx: Context = {
    context: {},
    nodes: {},
    request: {
      payload: {
        connectionId: 'conf-1',
        epicIssueType: 'Initiative',
        pageId: '9',
        projectKey: 'ENG',
        trackerConnectionId: 'trk-1',
      },
    },
    workflow: { id: 'wf-1' },
  };
  const result = await runSpec(spec, ctx, dispatcher);
  const wrote = (id: string) => calls.filter((c) => c.nodeId === id);
  return { calls, result, wrote };
}

describe('CONFLUENCE_REVIEW_TO_TICKETS_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    expect(WorkflowSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('a page that is not ready gets its comments and stops, without planning anything', async () => {
    const { result, calls, wrote } = await run({
      review: { ...READY_REVIEW, findingCount: 2, ready: false, summary: 'Gaps' },
    });
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({
      findings: 2,
      pageId: '9',
      ready: false,
      summary: 'Gaps',
    });
    expect(wrote('commentsAutoWrite')).toHaveLength(1);
    expect(calls.some((c) => c.nodeId === 'planTickets')).toBe(false);
    expect(calls.some((c) => c.nodeId.startsWith('tickets'))).toBe(false);
  });

  it('writes the comments to the page it read, on the Confluence connection', async () => {
    const { wrote } = await run({ review: { ...READY_REVIEW, ready: false } });
    expect(wrote('commentsAutoWrite')[0].inputs).toEqual({
      connectionId: 'conf-1',
      data: {
        comments: [{ body: 'Automated review: ready.', quote: '' }],
        pageId: '9',
      },
    });
  });

  it('a ready page is planned, approved by a person, and created on the tracker connection', async () => {
    const { result, wrote } = await run({
      signals: { hitl_approveStructure: [{ action: 'approve', resolvedBy: 'u1' }] },
    });
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({
      created: true,
      epicUrl: 'https://jira/browse/ENG-1',
      pageId: '9',
      ready: true,
      ticketUrls: ['https://jira/browse/ENG-1', 'https://jira/browse/ENG-2'],
    });
    const data = (wrote('ticketsAutoWrite')[0].inputs as { connectionId: string; data: unknown })
      .data;
    expect(wrote('ticketsAutoWrite')[0].inputs.connectionId).toBe('trk-1');
    expect(data).toMatchObject({
      epicIssueType: 'Initiative',
      plan: PLAN,
      projectKey: 'ENG',
      // Unset issue types are empty strings, which the write treats as "use the default".
      storyIssueType: '',
      subtaskIssueType: '',
    });
  });

  it('whatever the policy allows, a person reviews the structure before any ticket is created', async () => {
    // No answer to the structure review: it times out, and nothing is created.
    const { result, calls } = await run({ decision: 'auto' });
    expect(result.status).toBe('TIMED_OUT');
    expect(calls.some((c) => c.nodeId.startsWith('tickets'))).toBe(false);
  });

  it('a rejected structure creates nothing and says so', async () => {
    const { result, calls } = await run({
      signals: { hitl_approveStructure: [{ action: 'reject' }] },
    });
    expect(result.status).toBe('SUCCESS');
    expect(result.result).toEqual({ created: false, pageId: '9' });
    expect(calls.some((c) => c.nodeId.startsWith('tickets'))).toBe(false);
  });

  it('sends the person’s note back to the planner and plans again', async () => {
    const { result, calls } = await run({
      signals: {
        hitl_approveStructure: [
          { action: 'request_changes', comment: 'split the API work' },
          { action: 'approve' },
        ],
      },
    });
    expect(result.status).toBe('SUCCESS');
    const rounds = calls.filter((c) => c.nodeId === 'planTickets');
    expect(rounds).toHaveLength(2);
    expect(rounds[0].inputs.reviewerNote).toBe('');
    expect(rounds[1].inputs.reviewerNote).toBe('split the API work');
  });

  it(`gives up after ${MAX_PLAN_REVISIONS} requests for changes`, async () => {
    const change = { action: 'request_changes', comment: 'again' };
    const { result, calls } = await run({
      signals: {
        hitl_approveStructure: Array.from({ length: MAX_PLAN_REVISIONS + 2 }, () => change),
      },
    });
    expect(result.status).toBe('FAILED');
    expect(calls.filter((c) => c.nodeId === 'planTickets')).toHaveLength(MAX_PLAN_REVISIONS + 1);
    expect(calls.some((c) => c.nodeId.startsWith('tickets'))).toBe(false);
  });

  it('stops before any write when a reply is not the expected JSON', async () => {
    const badReview = await run({ review: { error: 'x', markdown: 'x', valid: false } });
    expect(badReview.result.status).toBe('FAILED');
    expect(badReview.calls.some((c) => c.nodeId.includes('Write'))).toBe(false);

    const badPlan = await run({
      plans: [{ error: 'x', markdown: 'x', valid: false }],
    });
    expect(badPlan.result.status).toBe('FAILED');
    expect(badPlan.calls.some((c) => c.nodeId.startsWith('tickets'))).toBe(false);
  });

  it('when the policy wants an approval for the comments, nothing is posted until it comes', async () => {
    const rejected = await run({
      decision: 'require_approval',
      review: { ...READY_REVIEW, ready: false },
      signals: { hitl_commentsHumanApproval: [{ action: 'reject' }] },
    });
    expect(rejected.result.result).toMatchObject({ approved: false, written: false });
    expect(rejected.calls.some((c) => c.nodeId.includes('Write'))).toBe(false);

    const approved = await run({
      decision: 'require_approval',
      review: { ...READY_REVIEW, ready: false },
      signals: { hitl_commentsHumanApproval: [{ action: 'approve' }] },
    });
    expect(approved.wrote('commentsManualWrite')).toHaveLength(1);
    expect(approved.wrote('commentsAutoWrite')).toHaveLength(0);
  });

  it('needs the policy approval for the tickets too, after the structure is approved', async () => {
    const { result, wrote } = await run({
      decision: 'require_approval',
      signals: {
        hitl_approveStructure: [{ action: 'approve' }],
        hitl_commentsHumanApproval: [{ action: 'approve' }],
        hitl_ticketsHumanApproval: [{ action: 'approve' }],
      },
    });
    expect(result.status).toBe('SUCCESS');
    expect(wrote('ticketsManualWrite')).toHaveLength(1);
    expect(wrote('ticketsAutoWrite')).toHaveLength(0);
  });
});
