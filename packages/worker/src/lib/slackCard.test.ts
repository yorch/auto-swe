import { describe, expect, it } from 'vitest';
import {
  parseSlackCard,
  renderSlackCard,
  SLACK_LIMITS,
  type SlackCardSpec,
  slackCardPrompt,
} from './slackCard.js';

function parseOk(spec: unknown, limits?: { maxBlocks?: number }): SlackCardSpec {
  const result = parseSlackCard(spec, limits);
  if (!result.ok) {
    throw new Error(`expected ok, got: ${result.issues.join('; ')}`);
  }
  return result.card;
}

function issuesOf(spec: unknown, limits?: { maxBlocks?: number }): string[] {
  const result = parseSlackCard(spec, limits);
  if (result.ok) {
    throw new Error('expected a refusal');
  }
  return result.issues;
}

describe('parseSlackCard', () => {
  it('accepts every component type', () => {
    const card = parseOk({
      blocks: [
        { text: 'Weekly run summary', type: 'header' },
        { text: '*3* runs finished', type: 'text' },
        { items: [{ label: 'Cost', value: '$1.20' }], type: 'fields' },
        { columns: ['Run', 'Status'], rows: [['a', 'ok']], type: 'table' },
        { text: 'generated now', type: 'context' },
        { type: 'divider' },
        { items: [{ label: 'Open', url: 'https://example.com/runs' }], type: 'buttons' },
      ],
    });
    expect(card.blocks).toHaveLength(7);
  });

  it('accepts the spec as JSON text and refuses text that is not JSON', () => {
    expect(parseOk('{"blocks":[{"type":"divider"}]}').blocks).toHaveLength(1);
    expect(issuesOf('{nope')).toEqual(['spec is not valid JSON']);
  });

  it('reports every problem as its own issue with a path', () => {
    const issues = issuesOf({
      blocks: [
        { text: '', type: 'header' },
        { type: 'chart' },
        { items: [{ label: 'x', url: 'javascript:alert(1)' }], type: 'buttons' },
      ],
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.some((i) => i.startsWith('blocks.0.text'))).toBe(true);
    expect(issues.some((i) => i.startsWith('blocks.1'))).toBe(true);
    expect(issues.some((i) => i.startsWith('blocks.2.items.0.url'))).toBe(true);
  });

  it.each(['ftp://example.com', 'not a url', '/relative', 'data:text/html,hi'])(
    'refuses the button URL %s',
    (url) => {
      expect(
        parseSlackCard({ blocks: [{ items: [{ label: 'Go', url }], type: 'buttons' }] }).ok
      ).toBe(false);
    }
  );

  it('refuses a ragged table row', () => {
    const issues = issuesOf({
      blocks: [{ columns: ['a', 'b'], rows: [['1']], type: 'table' }],
    });
    expect(issues).toEqual(['blocks.0.rows.0: row has 1 cells, expected 2']);
  });

  it('refuses a table that cannot fit in one section instead of truncating it', () => {
    const wide = 'x'.repeat(40);
    const rows = Array.from({ length: 30 }, () => [wide, wide, wide]);
    const issues = issuesOf({ blocks: [{ columns: ['a', 'b', 'c'], rows, type: 'table' }] });
    expect(issues.some((i) => i.includes('table renders to more than'))).toBe(true);
  });

  it('enforces Slack caps: block count, fields, buttons, header length', () => {
    const divider = { type: 'divider' as const };
    expect(parseSlackCard({ blocks: Array(SLACK_LIMITS.maxBlocks).fill(divider) }).ok).toBe(true);
    expect(parseSlackCard({ blocks: Array(SLACK_LIMITS.maxBlocks + 1).fill(divider) }).ok).toBe(
      false
    );
    expect(
      parseSlackCard({
        blocks: [
          {
            items: Array(SLACK_LIMITS.fieldsPerBlock + 1).fill({ label: 'a', value: 'b' }),
            type: 'fields',
          },
        ],
      }).ok
    ).toBe(false);
    expect(
      parseSlackCard({
        blocks: [
          {
            items: Array(SLACK_LIMITS.buttonsPerBlock + 1).fill({
              label: 'a',
              url: 'https://example.com',
            }),
            type: 'buttons',
          },
        ],
      }).ok
    ).toBe(false);
    expect(
      parseSlackCard({
        blocks: [{ text: 'h'.repeat(SLACK_LIMITS.headerText + 1), type: 'header' }],
      }).ok
    ).toBe(false);
  });

  it('lets a caller tighten the block cap but never loosen it', () => {
    const three = { blocks: Array(3).fill({ type: 'divider' }) };
    expect(issuesOf(three, { maxBlocks: 2 })).toEqual([
      'blocks: at most 2 components allowed, got 3',
    ]);
    expect(
      parseSlackCard({ blocks: Array(51).fill({ type: 'divider' }) }, { maxBlocks: 500 }).ok
    ).toBe(false);
  });

  it('refuses an empty card and a non-object', () => {
    expect(parseSlackCard({ blocks: [] }).ok).toBe(false);
    expect(parseSlackCard(null).ok).toBe(false);
    expect(parseSlackCard(42).ok).toBe(false);
  });
});

describe('renderSlackCard', () => {
  it('renders each component to one Slack block', () => {
    const card = parseOk({
      blocks: [
        { text: 'Title', type: 'header' },
        { text: 'body', type: 'text' },
        { items: [{ label: 'Cost', value: '$1' }], type: 'fields' },
        { columns: ['A'], rows: [['1']], type: 'table' },
        { text: 'foot', type: 'context' },
        { type: 'divider' },
        { items: [{ label: 'Open', url: 'https://example.com' }], type: 'buttons' },
      ],
    });
    const { blocks } = renderSlackCard(card);
    expect((blocks as Array<{ type: string }>).map((b) => b.type)).toEqual([
      'header',
      'section',
      'section',
      'section',
      'context',
      'divider',
      'actions',
    ]);
  });

  it('escapes mentions, broadcasts and disguised links in every text field', () => {
    const evil = '<!channel> <@U123> <https://evil.example|click> & done';
    const card = parseOk({
      blocks: [
        { text: evil, type: 'text' },
        { text: evil, type: 'context' },
        { items: [{ label: evil, value: evil }], type: 'fields' },
        { columns: ['c'], rows: [[evil]], type: 'table' },
      ],
      summary: evil,
    });
    const rendered = renderSlackCard(card);
    const json = JSON.stringify(rendered);
    expect(json).not.toContain('<!channel>');
    expect(json).not.toContain('<@U123>');
    expect(json).not.toContain('<https://evil.example');
    expect(rendered.text).toContain('&lt;!channel&gt;');
    expect(rendered.text).toContain('&amp; done');
  });

  it('keeps a table cell from ending the code fence', () => {
    const card = parseOk({
      blocks: [{ columns: ['c'], rows: [['``` @here']], type: 'table' }],
    });
    const [block] = renderSlackCard(card).blocks as Array<{ text: { text: string } }>;
    const text = block?.text.text ?? '';
    expect(text.match(/```/g)).toHaveLength(2);
  });

  it('aligns table columns and truncates long cells', () => {
    const card = parseOk({
      blocks: [
        {
          columns: ['id', 'note'],
          rows: [
            ['1', 'y'.repeat(100)],
            ['22', 'ok'],
          ],
          type: 'table',
        },
      ],
    });
    const [block] = renderSlackCard(card).blocks as Array<{ text: { text: string } }>;
    const lines = (block?.text.text ?? '').split('\n');
    expect(lines[2]).toBe('--  ----------------------------------------');
    expect(lines[3]).toMatch(/^1 {3}y+…$/);
    expect(lines[4]).toBe('22  ok');
  });

  it('gives link buttons distinct action ids and no value', () => {
    const card = parseOk({
      blocks: [
        { items: [{ label: 'A', url: 'https://a.example' }], type: 'buttons' },
        {
          items: [
            { label: 'B', url: 'https://b.example' },
            { label: 'C', url: 'https://c.example' },
          ],
          type: 'buttons',
        },
      ],
    });
    const actions = renderSlackCard(card).blocks as Array<{
      elements: Array<{ action_id: string; value?: string }>;
    }>;
    const ids = actions.flatMap((a) => a.elements.map((e) => e.action_id));
    expect(new Set(ids).size).toBe(3);
    expect(actions.flatMap((a) => a.elements).every((e) => e.value === undefined)).toBe(true);
  });

  it('chooses fallback text: summary, else first text-bearing block, else a stub', () => {
    expect(renderSlackCard(parseOk({ blocks: [{ type: 'divider' }], summary: 'S' })).text).toBe(
      'S'
    );
    expect(
      renderSlackCard(
        parseOk({ blocks: [{ type: 'divider' }, { text: 'Hi\nthere', type: 'text' }] })
      ).text
    ).toBe('Hi there');
    expect(renderSlackCard(parseOk({ blocks: [{ type: 'divider' }] })).text).toBe(
      'auto-swe update'
    );
  });
});

describe('slackCardPrompt', () => {
  it('names every component type the schema accepts', () => {
    const prompt = slackCardPrompt();
    for (const type of ['header', 'text', 'fields', 'table', 'context', 'divider', 'buttons']) {
      expect(prompt).toContain(`"type": "${type}"`);
    }
  });
});
