import { describe, expect, it } from 'vitest';
import { parseAgentOutput } from './parseAgentOutput.js';

describe('repository onboarding draft', () => {
  const draft = {
    gateCommands: { runTests: 'npm test' },
    notes: 'Requires Node.',
    previewConfig: { readyUrl: 'http://localhost:3000/', start: 'npm start' },
    setup: { steps: [{ name: 'install', run: 'npm ci' }] },
  };
  const fenced = (value: unknown) => `Draft:\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const parse = (text: unknown) => parseAgentOutput({ kind: 'repoOnboardingDraft', text });

  it('validates and summarizes all configuration for approval', async () => {
    const result = await parse(fenced(draft));
    expect(result).toMatchObject({
      draft: {
        ...draft,
        previewConfig: {
          ...draft.previewConfig,
          baseUrl: 'http://localhost:3000',
          readyTimeoutMs: 180000,
        },
      },
      valid: true,
    });
    expect(result).not.toHaveProperty('passed');
    for (const text of [
      '.auto-swe/setup.yml',
      '.auto-swe/gates.yml',
      '.auto-swe/preview.yml',
      'npm ci',
      'npm test',
      'Requires Node.',
    ]) {
      expect(result.markdown).toContain(text);
    }
  });

  it('accepts empty setup and gates and normalizes omitted optional fields', async () => {
    expect(await parse(fenced({ gateCommands: {}, setup: {} }))).toMatchObject({
      draft: { gateCommands: {}, notes: '', previewConfig: null, setup: {} },
      valid: true,
    });
    expect(await parse(fenced({ gateCommands: {}, previewConfig: null, setup: {} }))).toMatchObject(
      { valid: true }
    );
  });

  it.each([undefined, null, 42, '', 'No draft.', JSON.stringify(draft)])(
    'rejects a reply without a block: %j',
    async (text) => {
      const result = await parse(text);
      expect(result).toMatchObject({ error: expect.stringContaining('fenced JSON'), valid: false });
      if (!result.valid) {
        expect(result.markdown).toBe(result.error);
      }
    }
  );

  it('rejects invalid JSON', async () => {
    expect(await parse('```json\n{bad json}\n```')).toMatchObject({
      error: expect.stringContaining('invalid JSON'),
      valid: false,
    });
  });

  it.each([
    {},
    { gateCommands: { unknown: 'echo nope' }, setup: {} },
    { ...draft, setup: { steps: [{ run: 42 }] } },
    { ...draft, previewConfig: { readyUrl: 'https://example.com', start: 'npm start' } },
    { ...draft, notes: 42 },
    { ...draft, contentHash: 'spoofed' },
  ])('rejects schema violations: %j', async (value) => {
    expect(await parse(fenced(value))).toMatchObject({
      error: expect.stringContaining('invalid fields'),
      valid: false,
    });
  });

  it('takes the last JSON block, ignoring earlier drafts and other languages', async () => {
    const result = await parse(
      `${fenced({ ...draft, notes: 'old' })}\n${fenced(draft)}\n\`\`\`text\nignore\n\`\`\``
    );
    expect(result).toMatchObject({ draft: { notes: 'Requires Node.' }, valid: true });
  });

  it('does not fall back to an earlier valid block when the last is invalid', async () => {
    expect(await parse(`${fenced(draft)}\n\`\`\`json\nnot JSON\n\`\`\``)).toMatchObject({
      valid: false,
    });
    expect(await parse(`${fenced(draft)}\n${fenced({})}`)).toMatchObject({ valid: false });
  });

  it('supports CRLF and uppercase JSON fences', async () => {
    expect(
      await parse(fenced(draft).replace('```json', '```JSON').replaceAll('\n', '\r\n'))
    ).toMatchObject({ valid: true });
  });

  it('returns invalid rather than throwing if the rendered recipe exceeds the file parser limit', async () => {
    const env = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`VALUE_${i}`, 'x'.repeat(4000)])
    );
    expect(
      await parse(fenced({ ...draft, previewConfig: { ...draft.previewConfig, env } }))
    ).toMatchObject({ error: expect.stringContaining('cannot be rendered'), valid: false });
  });
});

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

  it('checks an incident triage and only lets a code diagnosis be fixable', async () => {
    const triage = {
      category: 'code',
      confidence: 0.8,
      evidence: ['alert: TypeError in checkout.ts'],
      fixable: true,
      rootCause: 'checkout.ts reads a field the API stopped sending',
      suggestedFix: 'Guard the missing field',
      summary: 'Checkout fails on a missing field.',
    };
    const out = await parseAgentOutput({ kind: 'incidentTriage', text: JSON.stringify(triage) });
    expect(out).toMatchObject({
      confidence: 0.8,
      fixable: true,
      kind: 'incidentTriage',
      valid: true,
    });
    if (out.valid && out.kind === 'incidentTriage') {
      expect(out.markdown).toContain('Root cause: checkout.ts');
      expect(out.brief).toBe(out.markdown);
    }
    const infra = await parseAgentOutput({
      kind: 'incidentTriage',
      text: JSON.stringify({ ...triage, category: 'infrastructure' }),
    });
    expect(infra).toMatchObject({ fixable: false, valid: true });
  });

  it('keeps an unparsed incident triage reply so it can still be posted', async () => {
    const out = await parseAgentOutput({ kind: 'incidentTriage', text: 'The database is down.' });
    expect(out).toMatchObject({ kind: 'incidentTriage', valid: false });
    expect(out.markdown).toContain('The database is down.');
  });
  it('renders an incident postmortem as plain text with its title', async () => {
    const postmortem = {
      followUps: ['Add a contract test for the payments client'],
      impact: 'Checkout failed for 18 minutes.',
      resolution: 'The upgrade was reverted.',
      rootCause: 'payments client 4.0 renamed a field checkout.ts reads',
      summary: 'Checkout failed after a client upgrade until it was reverted.',
      timeline: [{ at: '13:45', event: 'Incident triggered' }, { event: 'Resolved' }],
      title: 'Postmortem: checkout errors',
    };
    const out = await parseAgentOutput({
      kind: 'incidentPostmortem',
      text: JSON.stringify(postmortem),
    });
    expect(out).toMatchObject({
      kind: 'incidentPostmortem',
      summary: postmortem.summary,
      title: 'Postmortem: checkout errors',
      valid: true,
    });
    expect(out.markdown).toContain('Timeline\n- 13:45: Incident triggered\n- Resolved');
    expect(out.markdown).toContain('Follow-up actions\n- Add a contract test');
    expect(out.markdown).not.toContain('#');
  });

  it('keeps an unparsed postmortem reply for the note, without a title', async () => {
    const out = await parseAgentOutput({ kind: 'incidentPostmortem', text: 'It broke.' });
    expect(out).toMatchObject({ kind: 'incidentPostmortem', valid: false });
    expect(out.markdown).toContain('It broke.');
    expect('title' in out).toBe(false);
  });
});
