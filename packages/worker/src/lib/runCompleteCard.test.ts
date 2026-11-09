import { describe, expect, it } from 'vitest';
import { buildRunCompleteCard, formatCost, formatDuration } from './runCompleteCard.js';

const base = {
  dashboardHost: 'dash.example.com',
  runUrl: 'https://dash.example.com/runs/abc',
  status: 'SUCCESS' as const,
  templateName: 'default',
  ticket: 'JIRA-200',
};

type Block = { type: string; [key: string]: unknown };

const fieldTexts = (block?: Block): string[] =>
  ((block?.fields ?? []) as Array<{ text: string }>).map((f) => f.text);
const elementsOf = (block?: Block): Array<{ url: string; text: { text: string } }> =>
  (block?.elements ?? []) as Array<{ url: string; text: { text: string } }>;

describe('formatDuration', () => {
  const t0 = new Date('2026-06-01T00:00:00Z');
  const after = (ms: number) => new Date(t0.getTime() + ms);

  it.each([
    [200, '<1s'],
    [45_000, '45s'],
    [192_000, '3m 12s'],
    [3_900_000, '1h 5m'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(t0, after(ms))).toBe(expected);
  });

  it('is null when an end is missing or the span is negative', () => {
    expect(formatDuration(null, after(1000))).toBeNull();
    expect(formatDuration(t0, undefined)).toBeNull();
    expect(formatDuration(after(1000), t0)).toBeNull();
  });
});

describe('formatCost', () => {
  it('formats a spend, flags a tiny one, and hides nothing-to-show', () => {
    expect(formatCost(0.4213)).toBe('$0.42');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0)).toBeNull();
    expect(formatCost(null)).toBeNull();
    expect(formatCost(Number.NaN)).toBeNull();
  });
});

describe('buildRunCompleteCard', () => {
  it('renders the line, status/duration/cost fields and an Open run link button', () => {
    const card = buildRunCompleteCard({
      ...base,
      costUsd: 1.5,
      endedAt: new Date('2026-06-01T00:03:12Z'),
      startedAt: new Date('2026-06-01T00:00:00Z'),
    });
    expect(card).not.toBeNull();
    const blocks = (card?.blocks ?? []) as Block[];
    expect(blocks.map((b) => b.type)).toEqual(['section', 'section', 'actions']);
    expect(fieldTexts(blocks[1])).toEqual([
      '*Status*\nSUCCESS',
      '*Duration*\n3m 12s',
      '*Cost*\n$1.50',
    ]);
    const button = elementsOf(blocks[2])[0];
    expect(button?.url).toBe('https://dash.example.com/runs/abc');
    expect(button?.text.text).toBe('Open run');
  });

  it('keeps the fallback text carrying the ticket and the status', () => {
    const card = buildRunCompleteCard({ ...base, status: 'FAILED' });
    expect(card?.text).toContain('JIRA-200');
    expect(card?.text).toContain('FAILED');
  });

  it('omits duration and cost when the run row does not have them', () => {
    const card = buildRunCompleteCard(base);
    const blocks = (card?.blocks ?? []) as Block[];
    expect(fieldTexts(blocks[1])).toEqual(['*Status*\nSUCCESS']);
  });

  it('uses a stop sign for a cancelled run and an alarm for a failed one', () => {
    const text = (status: 'CANCELLED' | 'FAILED') =>
      JSON.stringify(buildRunCompleteCard({ ...base, status })?.blocks);
    expect(text('CANCELLED')).toContain(':octagonal_sign:');
    expect(text('FAILED')).toContain(':rotating_light:');
  });

  it('escapes a ticket or template that tries to ping or link', () => {
    const card = buildRunCompleteCard({
      ...base,
      templateName: '<@U123> `x`',
      ticket: '<!channel> <https://evil.example|click>',
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<@U123>');
    expect(json).not.toContain('<https://evil.example');
    expect(json).toContain('&lt;!channel&gt;');
  });

  it('clips a very long ticket instead of getting refused', () => {
    const card = buildRunCompleteCard({ ...base, ticket: 'T'.repeat(5000) });
    expect(card).not.toBeNull();
  });

  it('returns null when the run URL is not on the dashboard host, so the caller falls back', () => {
    expect(buildRunCompleteCard({ ...base, runUrl: 'https://evil.example/runs/abc' })).toBeNull();
    expect(buildRunCompleteCard({ ...base, runUrl: 'not a url' })).toBeNull();
  });
});
