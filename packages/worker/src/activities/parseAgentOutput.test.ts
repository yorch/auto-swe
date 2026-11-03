import { describe, expect, it } from 'vitest';
import { parseAgentOutput } from './parseAgentOutput.js';

describe('parseAgentOutput', () => {
  it('checks a review and reports readiness, counts and the comments to post', async () => {
    const out = await parseAgentOutput({
      kind: 'docReview',
      text: JSON.stringify({
        findings: [{ comment: 'gap', quote: 'q', section: 'S', severity: 'major' }],
        ready: true,
        summary: 'Nearly',
      }),
    });
    expect(out).toMatchObject({
      blockingCount: 1,
      findingCount: 1,
      kind: 'docReview',
      ready: false,
      valid: true,
    });
    if (out.valid && out.kind === 'docReview') {
      expect(out.comments).toHaveLength(2);
      expect(out.markdown).toContain('## Review: not ready');
    }
  });

  it('checks a plan and counts its tickets and sub-tasks', async () => {
    const out = await parseAgentOutput({
      kind: 'ticketPlan',
      text: '```json\n{"epic":{"title":"E"},"tickets":[{"title":"A","subtasks":[{"title":"x"},{"title":"y"}]},{"title":"B"}]}\n```',
    });
    expect(out).toMatchObject({ kind: 'ticketPlan', subtaskCount: 2, ticketCount: 2, valid: true });
  });

  it('reports a reply that is not JSON as invalid with a fixed message, and never throws', async () => {
    for (const text of ['sorry', undefined, 42, null, { not: 'text' }]) {
      for (const kind of ['docReview', 'ticketPlan'] as const) {
        const out = await parseAgentOutput({ kind, text });
        expect(out.valid).toBe(false);
        if (!out.valid) {
          expect(out.error).toMatch(/did not return a JSON object/);
          expect(out.markdown).toBe(out.error);
        }
      }
    }
  });
});
