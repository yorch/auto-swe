import { describe, expect, it } from 'vitest';
import {
  countOccurrences,
  extractJsonObject,
  MAX_PLAN_TICKETS,
  MAX_REVIEW_FINDINGS,
  MAX_SUBTASKS_PER_TICKET,
  parseDocReview,
  parseTicketPlan,
  renderPlanMarkdown,
  renderReviewMarkdown,
  reviewToComments,
} from './documentReview.js';

const review = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    findings: [
      {
        comment: 'Say who owns it',
        quote: 'Ownership is TBD',
        section: 'Scope',
        severity: 'minor',
      },
      { comment: 'No success metric', quote: '', section: 'Goals', severity: 'blocker' },
    ],
    ready: false,
    summary: 'Not ready: no metric.',
    ...over,
  });

describe('extractJsonObject', () => {
  it('reads bare JSON, a fenced block, and JSON inside a sentence', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go: {"a":{"b":2}} Thanks.')).toEqual({ a: { b: 2 } });
  });

  it('returns undefined for anything that is not a JSON object', () => {
    for (const raw of ['', 'no json', '[1,2]', '"text"', '{broken', '42']) {
      expect(extractJsonObject(raw)).toBeUndefined();
    }
  });
});

describe('parseDocReview', () => {
  it('accepts a review and defaults the optional finding fields', () => {
    const parsed = parseDocReview(
      JSON.stringify({ findings: [{ comment: 'x', severity: 'nit' }], ready: true, summary: 'ok' })
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        findings: [{ comment: 'x', quote: '', section: '', severity: 'nit' }],
        ready: true,
        summary: 'ok',
      },
    });
  });

  it('is never ready with a blocker or a major finding, whatever the model said', () => {
    for (const severity of ['blocker', 'major']) {
      const parsed = parseDocReview(
        review({ findings: [{ comment: 'gap', severity }], ready: true })
      );
      expect(parsed.ok && parsed.value.ready).toBe(false);
    }
  });

  it('stays ready with only minor findings and nits', () => {
    const parsed = parseDocReview(
      review({
        findings: [
          { comment: 'a', severity: 'minor' },
          { comment: 'b', severity: 'nit' },
        ],
        ready: true,
      })
    );
    expect(parsed.ok && parsed.value.ready).toBe(true);
  });

  it('refuses a reply that is not the shape, with a fixed message that quotes nothing', () => {
    for (const raw of [
      'sorry, I cannot',
      review({ ready: 'yes' }),
      review({ summary: '' }),
      review({ findings: [{ comment: 'x', severity: 'critical' }] }),
      review({
        findings: Array.from({ length: MAX_REVIEW_FINDINGS + 1 }, () => ({
          comment: 'x',
          severity: 'nit',
        })),
      }),
    ]) {
      const parsed = parseDocReview(raw);
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain('critical');
    }
  });
});

describe('parseTicketPlan', () => {
  const plan = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      epic: { description: 'd', title: 'Epic' },
      rationale: 'r',
      tickets: [{ description: 'd', subtasks: [{ title: 's' }], title: 'T' }],
      ...over,
    });

  it('accepts a plan and fills the optional fields', () => {
    const parsed = parseTicketPlan(plan());
    expect(parsed.ok && parsed.value.tickets[0]).toEqual({
      acceptanceCriteria: [],
      description: 'd',
      subtasks: [{ description: '', title: 's' }],
      title: 'T',
    });
  });

  it('refuses no tickets, a blank title, and more than the caps allow', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `t${i}` }));
    for (const raw of [
      plan({ tickets: [] }),
      plan({ epic: { title: ' ' } }),
      plan({ tickets: many(MAX_PLAN_TICKETS + 1) }),
      plan({ tickets: [{ subtasks: many(MAX_SUBTASKS_PER_TICKET + 1), title: 'T' }] }),
      'not json',
    ]) {
      expect(parseTicketPlan(raw).ok).toBe(false);
    }
  });
});

describe('what a person reads and what is posted', () => {
  it('renders a review with its findings, located and quoted', () => {
    const parsed = parseDocReview(review());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const md = renderReviewMarkdown(parsed.value);
    expect(md).toContain('## Review: not ready');
    expect(md).toContain('- **blocker**, Goals: No success metric');
    expect(md).toContain('> Ownership is TBD');
  });

  it('turns a review into a verdict comment first and then findings, worst first', () => {
    const parsed = parseDocReview(review());
    if (!parsed.ok) {
      throw new Error('expected a valid review');
    }
    const comments = reviewToComments(parsed.value);
    expect(comments.map((c) => c.body)).toEqual([
      'Automated review: not ready. Not ready: no metric.',
      '[blocker] Goals: No success metric',
      '[minor] Scope: Say who owns it',
    ]);
    expect(comments.map((c) => c.quote)).toEqual(['', '', 'Ownership is TBD']);
  });

  it('renders a plan with its tickets, criteria and sub-tasks', () => {
    const parsed = parseTicketPlan(
      JSON.stringify({
        epic: { description: 'Do it', title: 'Epic' },
        rationale: 'Split by area',
        tickets: [
          {
            acceptanceCriteria: ['works'],
            description: 'Build',
            subtasks: [{ title: 'Design' }],
            title: 'A',
          },
        ],
      })
    );
    if (!parsed.ok) {
      throw new Error('expected a valid plan');
    }
    const md = renderPlanMarkdown(parsed.value);
    expect(md).toContain('## Epic: Epic');
    expect(md).toContain('### 1. A');
    expect(md).toContain('- works');
    expect(md).toContain('- Design');
    expect(md).toContain('Rationale: Split by area');
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping matches, and none for an empty needle', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('The API. The API.', 'The API')).toBe(2);
    expect(countOccurrences('abc', '')).toBe(0);
    expect(countOccurrences('abc', 'z')).toBe(0);
  });
});
