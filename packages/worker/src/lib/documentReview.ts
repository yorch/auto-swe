/**
 * The two JSON documents the document-review agents return, and what the platform does with
 * them: a review (`docReviewer`) and a ticket plan (`ticketPlanner`).
 *
 * Model output is parsed here, in code, and never trusted for its shape: a reply that does not
 * match its schema is `valid: false` with a fixed error string (never the model's text), and the
 * template routes that to a person instead of writing anything. The caps are limits on what one
 * run may write to Confluence and the tracker, not on what a model may say.
 */
import { z } from 'zod';

export const MAX_REVIEW_FINDINGS = 50;
export const MAX_PLAN_TICKETS = 40;
export const MAX_SUBTASKS_PER_TICKET = 10;

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type FindingSeverity = (typeof SEVERITIES)[number];

export const DocReviewSchema = z.object({
  findings: z
    .array(
      z.object({
        comment: z.string().trim().min(1),
        quote: z.string().default(''),
        section: z.string().default(''),
        severity: z.enum(SEVERITIES),
      })
    )
    .max(MAX_REVIEW_FINDINGS)
    .default([]),
  ready: z.boolean(),
  summary: z.string().trim().min(1),
});
export type DocReview = z.infer<typeof DocReviewSchema>;

const TicketSchema = z.object({
  acceptanceCriteria: z.array(z.string().trim().min(1)).default([]),
  description: z.string().default(''),
  subtasks: z
    .array(z.object({ description: z.string().default(''), title: z.string().trim().min(1) }))
    .max(MAX_SUBTASKS_PER_TICKET)
    .default([]),
  title: z.string().trim().min(1),
});

export const TicketPlanSchema = z.object({
  epic: z.object({ description: z.string().default(''), title: z.string().trim().min(1) }),
  rationale: z.string().default(''),
  tickets: z.array(TicketSchema).min(1).max(MAX_PLAN_TICKETS),
});
export type TicketPlan = z.infer<typeof TicketPlanSchema>;

/**
 * The JSON object in an agent's reply: the whole text, or what sits between the first `{` and the
 * last `}` (a code fence or a sentence around it). `undefined` when there is no JSON object.
 */
export function extractJsonObject(raw: string): unknown {
  const candidates = [raw.trim()];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    candidates.push(raw.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A review from the agent's reply. `ready` is decided here, not taken on trust: a review that
 * lists a blocker or a major finding is not ready whatever the model said.
 */
export function parseDocReview(raw: string): Parsed<DocReview> {
  const json = extractJsonObject(raw);
  if (json === undefined) {
    return { error: 'The reviewer did not return a JSON object.', ok: false };
  }
  const parsed = DocReviewSchema.safeParse(json);
  if (!parsed.success) {
    return { error: 'The reviewer returned JSON that does not match the review shape.', ok: false };
  }
  const blocking = parsed.data.findings.some(
    (f) => f.severity === 'blocker' || f.severity === 'major'
  );
  return { ok: true, value: { ...parsed.data, ready: parsed.data.ready && !blocking } };
}

export function parseTicketPlan(raw: string): Parsed<TicketPlan> {
  const json = extractJsonObject(raw);
  if (json === undefined) {
    return { error: 'The planner did not return a JSON object.', ok: false };
  }
  const parsed = TicketPlanSchema.safeParse(json);
  if (!parsed.success) {
    return {
      error: `The planner returned JSON that does not match the plan shape, or more than ${MAX_PLAN_TICKETS} tickets or ${MAX_SUBTASKS_PER_TICKET} sub-tasks on one.`,
      ok: false,
    };
  }
  return { ok: true, value: parsed.data };
}

export function renderReviewMarkdown(review: DocReview): string {
  const lines = [`## Review: ${review.ready ? 'ready' : 'not ready'}`, '', review.summary, ''];
  if (review.findings.length === 0) {
    lines.push('No findings.');
  }
  for (const f of review.findings) {
    lines.push(`- **${f.severity}**${f.section ? `, ${f.section}` : ''}: ${f.comment}`);
    if (f.quote) {
      lines.push(`  > ${f.quote}`);
    }
  }
  return lines.join('\n');
}

export function renderPlanMarkdown(plan: TicketPlan): string {
  const lines = [`## Epic: ${plan.epic.title}`, '', plan.epic.description, ''];
  plan.tickets.forEach((ticket, i) => {
    lines.push(`### ${i + 1}. ${ticket.title}`, '', ticket.description);
    if (ticket.acceptanceCriteria.length > 0) {
      lines.push('', 'Acceptance criteria:', ...ticket.acceptanceCriteria.map((c) => `- ${c}`));
    }
    if (ticket.subtasks.length > 0) {
      lines.push('', 'Sub-tasks:', ...ticket.subtasks.map((t) => `- ${t.title}`));
    }
    lines.push('');
  });
  if (plan.rationale) {
    lines.push('---', `Rationale: ${plan.rationale}`);
  }
  return lines.join('\n').trimEnd();
}

/** One comment to leave on the page: its text and, when it has one, the passage it is about. */
export interface ReviewComment {
  body: string;
  quote: string;
}

/** The comments a review becomes: a verdict first, then one per finding, worst first. */
export function reviewToComments(review: DocReview): ReviewComment[] {
  const rank = new Map(SEVERITIES.map((s, i) => [s, i]));
  const ordered = [...review.findings].sort(
    (a, b) => (rank.get(a.severity) ?? 0) - (rank.get(b.severity) ?? 0)
  );
  return [
    {
      body: `Automated review: ${review.ready ? 'ready' : 'not ready'}. ${review.summary}`,
      quote: '',
    },
    ...ordered.map((f) => ({
      body: `[${f.severity}] ${f.section ? `${f.section}: ` : ''}${f.comment}`,
      quote: f.quote.trim(),
    })),
  ];
}

/** Non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') {
    return 0;
  }
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count++;
  }
  return count;
}
