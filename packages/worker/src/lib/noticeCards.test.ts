import { describe, expect, it } from 'vitest';
import { buildPrReadyCard, buildStepFailureCard } from './noticeCards.js';

type Block = { type: string; [key: string]: unknown };

const blocksOf = (card: { blocks: unknown[] } | null): Block[] => (card?.blocks ?? []) as Block[];
const textOf = (block?: Block): string => (block?.text as { text: string } | undefined)?.text ?? '';
const fieldTexts = (block?: Block): string[] =>
  ((block?.fields ?? []) as Array<{ text: string }>).map((f) => f.text);
const buttons = (block?: Block): Array<{ url: string; text: { text: string } }> =>
  (block?.elements ?? []) as Array<{ url: string; text: { text: string } }>;

const failure = {
  attempt: 1,
  dashboardHost: 'dash.example.com',
  nodeId: 'runLint',
  runUrl: 'https://dash.example.com/runs/abc',
  templateName: 'ticket-to-merge',
  ticket: 'JIRA-7',
};

describe('buildStepFailureCard', () => {
  it('renders the line, step and attempt fields, the error in a code block and an Open run button', () => {
    const card = buildStepFailureCard({ ...failure, error: 'lint failed' });
    const blocks = blocksOf(card);
    expect(blocks.map((b) => b.type)).toEqual(['section', 'section', 'section', 'actions']);
    expect(textOf(blocks[0])).toContain('*[JIRA-7]*');
    expect(fieldTexts(blocks[1])).toEqual(['*Step*\nrunLint', '*Attempt*\n1']);
    expect(textOf(blocks[2])).toBe('```\nlint failed\n```');
    expect(buttons(blocks[3])[0]?.url).toBe('https://dash.example.com/runs/abc');
  });

  it('keeps the fallback text carrying the ticket, step and error', () => {
    const text = buildStepFailureCard({ ...failure, error: 'lint failed' })?.text ?? '';
    expect(text).toContain('JIRA-7');
    expect(text).toContain('runLint');
    expect(text).toContain('lint failed');
  });

  it('has no code block when there is no error text', () => {
    for (const error of [undefined, '', '   ']) {
      const blocks = blocksOf(buildStepFailureCard({ ...failure, error }));
      expect(
        blocks.map((b) => b.type),
        String(error)
      ).toEqual(['section', 'section', 'actions']);
    }
  });

  it('cannot be made to end its code fence early, or to ping', () => {
    const card = buildStepFailureCard({
      ...failure,
      error: 'x ``` <!channel> <@U1> <https://evil.example|go> & done',
      nodeId: '<!here>',
      ticket: '<!channel>',
    });
    const json = JSON.stringify(card);
    expect(json).not.toMatch(/<[!@h]/);
    const errorBlock = textOf(blocksOf(card)[2]);
    expect(errorBlock.match(/```/g)).toHaveLength(2);
    expect(errorBlock).toContain('&lt;!channel&gt;');
  });

  it('clips a long error and still builds', () => {
    const card = buildStepFailureCard({ ...failure, error: 'e'.repeat(5000) });
    expect(card).not.toBeNull();
    expect(textOf(blocksOf(card)[2]).length).toBeLessThan(450);
  });

  it('returns null for a run URL off the dashboard host, so the caller falls back', () => {
    expect(
      buildStepFailureCard({ ...failure, runUrl: 'https://evil.example/runs/abc' })
    ).toBeNull();
    expect(buildStepFailureCard({ ...failure, runUrl: 'not a url' })).toBeNull();
  });
});

describe('buildPrReadyCard', () => {
  const pr = {
    allowedLinkHosts: ['github.com', 'dash.example.com'],
    prNumber: 7,
    prUrl: 'https://github.com/o/r/pull/7',
    ticket: 'JIRA-5',
  };

  it('renders the line and an Open PR button', () => {
    const card = buildPrReadyCard(pr);
    const blocks = blocksOf(card);
    expect(blocks.map((b) => b.type)).toEqual(['section', 'actions']);
    expect(textOf(blocks[0])).toBe(':eyes: *[JIRA-5]* PR #7 is ready for review');
    expect(buttons(blocks[1])[0]).toMatchObject({
      text: { text: 'Open PR' },
      url: 'https://github.com/o/r/pull/7',
    });
    expect(card?.text).toContain('JIRA-5');
  });

  it('returns null for a PR on a host that is not allowed', () => {
    expect(
      buildPrReadyCard({ ...pr, prUrl: 'https://ghe.unlisted.example/o/r/pull/7' })
    ).toBeNull();
    expect(buildPrReadyCard({ ...pr, allowedLinkHosts: [] })).toBeNull();
  });

  it('escapes a ticket that tries to ping', () => {
    const json = JSON.stringify(buildPrReadyCard({ ...pr, ticket: '<!channel> <@U1>' }));
    expect(json).not.toMatch(/<[!@]/);
  });
});
