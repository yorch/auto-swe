import {
  type DocReview,
  parseDocReview,
  parseTicketPlan,
  type ReviewComment,
  renderPlanMarkdown,
  renderReviewMarkdown,
  reviewToComments,
  type TicketPlan,
} from '../lib/documentReview.js';

export type ParseAgentOutputKind = 'docReview' | 'ticketPlan';

export interface ParseAgentOutputInput {
  kind: ParseAgentOutputKind;
  /** The agent's reply: `nodes.<id>.output.text`. Anything that is not text is invalid output. */
  text: unknown;
}

export interface ParsedDocReview {
  kind: 'docReview';
  valid: true;
  ready: boolean;
  summary: string;
  findingCount: number;
  blockingCount: number;
  comments: ReviewComment[];
  markdown: string;
  review: DocReview;
}

export interface ParsedTicketPlan {
  kind: 'ticketPlan';
  valid: true;
  plan: TicketPlan;
  ticketCount: number;
  subtaskCount: number;
  markdown: string;
}

export interface UnparsedAgentOutput {
  kind: ParseAgentOutputKind;
  valid: false;
  /** A fixed string, never the model's text. */
  error: string;
  markdown: string;
}

export type ParseAgentOutputResult = ParsedDocReview | ParsedTicketPlan | UnparsedAgentOutput;

/**
 * Turn a document-review agent's JSON reply into a checked value and the text a person reviews.
 *
 * Deterministic and side-effect free, and an activity only because a workflow cannot parse: the
 * template branches on `valid`, so a malformed reply goes to a person rather than into a write.
 * It never throws on bad model output.
 */
export async function parseAgentOutput(
  input: ParseAgentOutputInput
): Promise<ParseAgentOutputResult> {
  const text = typeof input.text === 'string' ? input.text : '';
  if (input.kind === 'docReview') {
    const parsed = parseDocReview(text);
    if (!parsed.ok) {
      return { error: parsed.error, kind: 'docReview', markdown: parsed.error, valid: false };
    }
    const review = parsed.value;
    return {
      blockingCount: review.findings.filter(
        (f) => f.severity === 'blocker' || f.severity === 'major'
      ).length,
      comments: reviewToComments(review),
      findingCount: review.findings.length,
      kind: 'docReview',
      markdown: renderReviewMarkdown(review),
      ready: review.ready,
      review,
      summary: review.summary,
      valid: true,
    };
  }
  const parsed = parseTicketPlan(text);
  if (!parsed.ok) {
    return { error: parsed.error, kind: 'ticketPlan', markdown: parsed.error, valid: false };
  }
  const plan = parsed.value;
  return {
    kind: 'ticketPlan',
    markdown: renderPlanMarkdown(plan),
    plan,
    subtaskCount: plan.tickets.reduce((n, t) => n + t.subtasks.length, 0),
    ticketCount: plan.tickets.length,
    valid: true,
  };
}
