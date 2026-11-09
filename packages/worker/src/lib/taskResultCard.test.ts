import { describe, expect, it } from 'vitest';
import { buildTaskResultCard, splitForSlack } from './taskResultCard.js';

type Block = { type: string; [key: string]: unknown };

const blocksOf = (card: { blocks: unknown[] } | null): Block[] => (card?.blocks ?? []) as Block[];
const textOf = (block?: Block): string => (block?.text as { text: string } | undefined)?.text ?? '';
const fieldTexts = (block?: Block): string[] =>
  ((block?.fields ?? []) as Array<{ text: string }>).map((f) => f.text);

const base = {
  dashboardHost: 'dash.example.com',
  fallbackText: ':white_check_mark: Task *Summarise* is done:\n\nThe answer.',
  runUrl: 'https://dash.example.com/runs/abc',
  status: 'SUCCESS' as const,
  title: 'Summarise',
};

describe('splitForSlack', () => {
  it('keeps short text as one piece', () => {
    expect(splitForSlack('hello\n\nworld')).toEqual(['hello\n\nworld']);
  });

  it('splits long text on paragraph boundaries within the limit', () => {
    const para = 'p'.repeat(1500);
    const pieces = splitForSlack(`${para}\n\n${para}\n\n${para}`, 2400);
    expect(pieces).toHaveLength(3);
    expect(pieces.every((p) => p.length <= 2400)).toBe(true);
  });

  it('cuts an over-long line rather than refusing it', () => {
    const pieces = splitForSlack('x'.repeat(7000), 2400);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieces.every((p) => p.length <= 2400)).toBe(true);
    expect(pieces.join('')).toBe('x'.repeat(7000));
  });

  it('drops empty pieces', () => {
    expect(splitForSlack('   \n\n  ')).toEqual([]);
  });
});

describe('buildTaskResultCard', () => {
  it('renders the headline, the result, status/duration/cost and an Open run button', () => {
    const card = buildTaskResultCard({
      ...base,
      costUsd: 0.42,
      endedAt: new Date('2026-06-01T00:01:05Z'),
      resultText: 'The answer is 42.',
      startedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const blocks = blocksOf(card);
    expect(blocks.map((b) => b.type)).toEqual(['section', 'section', 'section', 'actions']);
    expect(textOf(blocks[0])).toBe(':white_check_mark: Task *Summarise* is done');
    expect(textOf(blocks[1])).toBe('The answer is 42.');
    expect(fieldTexts(blocks[2])).toEqual([
      '*Status*\nSUCCESS',
      '*Duration*\n1m 5s',
      '*Cost*\n$0.42',
    ]);
    expect(card?.text).toContain('Summarise');
  });

  it('splits a long result across several sections that each fit Slack', () => {
    const card = buildTaskResultCard({
      ...base,
      resultText: `${'a'.repeat(1800)}\n\n${'b'.repeat(1800)}`,
    });
    expect(card).not.toBeNull();
    const text = blocksOf(card).filter((b) => b.type === 'section' && b.text);
    expect(text.length).toBeGreaterThanOrEqual(3); // headline + at least two body sections
    expect(text.every((b) => textOf(b).length <= 3000)).toBe(true);
  });

  it('shows a failed task with its reason instead of a result', () => {
    const card = buildTaskResultCard({
      ...base,
      fallbackText: ':rotating_light: Task *Summarise* finished with status *FAILED*. no price',
      reason: 'Model "x/y" has no price in the model catalog.',
      resultText: 'ignored on failure',
      status: 'FAILED',
    });
    const blocks = blocksOf(card);
    expect(textOf(blocks[0])).toBe(
      ':rotating_light: Task *Summarise* finished with status *FAILED*'
    );
    expect(textOf(blocks[1])).toContain('has no price');
    expect(JSON.stringify(card)).not.toContain('ignored on failure');
  });

  it('works with no title, no result text and no stats', () => {
    const card = buildTaskResultCard({ ...base, resultText: '', title: undefined });
    const blocks = blocksOf(card);
    expect(blocks.map((b) => b.type)).toEqual(['section', 'section', 'actions']);
    expect(textOf(blocks[0])).toBe(':white_check_mark: Task is done');
    expect(fieldTexts(blocks[1])).toEqual(['*Status*\nSUCCESS']);
  });

  it('escapes model prose and the title, so a result cannot broadcast, mention or disguise a link', () => {
    const card = buildTaskResultCard({
      ...base,
      resultText: 'Done <!channel> cc <@U123> see <https://evil.example|the report> & more',
      title: '<!here> task',
    });
    const json = JSON.stringify(card);
    expect(json).not.toMatch(/<[!@h]/);
    expect(json).toContain('&lt;!channel&gt;');
    expect(json).toContain('&lt;https://evil.example|the report&gt; &amp; more');
  });

  it('returns null for a run URL off the dashboard host, so the caller falls back', () => {
    expect(
      buildTaskResultCard({ ...base, resultText: 'x', runUrl: 'https://evil.example/r' })
    ).toBeNull();
  });
});
