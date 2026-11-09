/**
 * Slack cards: a small, closed catalog of message components a model may emit as JSON, validated
 * by fixed code and rendered to Block Kit.
 *
 * The model never writes Block Kit. It writes a `SlackCardSpec` (a flat list of typed components),
 * `parseSlackCard` checks it and reports EVERY problem as a separate string (so the list can go
 * straight back to the model for a corrected spec), and `renderSlackCard` turns an accepted card
 * into `blocks` plus a plain-text fallback. Slack's per-message caps are enforced at parse time:
 * a spec that would not fit is refused, never silently degraded.
 *
 * Pure and I/O-free; nothing here posts anything.
 *
 * Text safety: every model-supplied string is escaped for Slack (`&`, `<`, `>`), so a card cannot
 * carry a `<!channel>` broadcast, a `<@U…>` mention or a disguised `<url|label>` link. The only
 * links are `buttons` items, restricted to http(s) URLs. Buttons are link buttons only: they carry
 * no interactive action, so a card cannot trigger anything when clicked.
 */
import { z } from 'zod';

/** Slack's hard caps for one message (`chat.postMessage` / `chat.update`). */
export const SLACK_LIMITS = {
  buttonLabel: 75,
  buttonsPerBlock: 5,
  fallbackText: 300,
  fieldsPerBlock: 10,
  fieldText: 2000,
  headerText: 150,
  maxBlocks: 50,
  sectionText: 3000,
} as const;

/** Table cells wider than this are truncated with an ellipsis. */
const MAX_CELL_CHARS = 40;
const MAX_TABLE_COLUMNS = 6;
const MAX_TABLE_ROWS = 30;
/** Leaves room for the code fence inside a section's 3000-character text. */
const MAX_TABLE_TEXT = SLACK_LIMITS.sectionText - 20;

/** Caller-tunable caps; each can only tighten what Slack already enforces. */
export interface SlackCardLimits {
  /** Maximum number of components (one Slack block each). Defaults to Slack's 50. */
  maxBlocks?: number;
  /**
   * `host[:port]` values a button may link to (exact match, no wildcards or suffixes). Omitted:
   * any http(s) URL passes. A URL carrying userinfo is refused whenever this is set, since
   * `https://trusted.example@evil.example` reads as the trusted host to a person.
   */
  allowedLinkHosts?: readonly string[];
}

const httpUrl = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === 'https:' || protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute http(s) URL' }
  );

const headerBlock = z.object({
  text: z.string().min(1).max(SLACK_LIMITS.headerText),
  type: z.literal('header'),
});

const textBlock = z.object({
  text: z.string().min(1).max(SLACK_LIMITS.sectionText),
  type: z.literal('text'),
});

const contextBlock = z.object({
  text: z.string().min(1).max(SLACK_LIMITS.fieldText),
  type: z.literal('context'),
});

const dividerBlock = z.object({ type: z.literal('divider') });

const fieldsBlock = z.object({
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        value: z
          .string()
          .min(1)
          .max(SLACK_LIMITS.fieldText - 202),
      })
    )
    .min(1)
    .max(SLACK_LIMITS.fieldsPerBlock),
  type: z.literal('fields'),
});

const tableBlock = z
  .object({
    columns: z.array(z.string().min(1)).min(1).max(MAX_TABLE_COLUMNS),
    rows: z.array(z.array(z.string())).max(MAX_TABLE_ROWS),
    type: z.literal('table'),
  })
  .superRefine((table, ctx) => {
    for (const [i, row] of table.rows.entries()) {
      if (row.length !== table.columns.length) {
        ctx.addIssue({
          code: 'custom',
          message: `row has ${row.length} cells, expected ${table.columns.length}`,
          path: ['rows', i],
        });
      }
    }
    if (renderTableText(table.columns, table.rows).length > MAX_TABLE_TEXT) {
      ctx.addIssue({
        code: 'custom',
        message: `table renders to more than ${MAX_TABLE_TEXT} characters; use fewer rows or columns`,
        path: [],
      });
    }
  });

const buttonsBlock = z.object({
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(SLACK_LIMITS.buttonLabel),
        url: httpUrl,
      })
    )
    .min(1)
    .max(SLACK_LIMITS.buttonsPerBlock),
  type: z.literal('buttons'),
});

export const slackCardSchema = z.object({
  blocks: z
    .array(
      z.discriminatedUnion('type', [
        headerBlock,
        textBlock,
        fieldsBlock,
        tableBlock,
        contextBlock,
        dividerBlock,
        buttonsBlock,
      ])
    )
    .min(1)
    .max(SLACK_LIMITS.maxBlocks),
  /** Plain-text fallback for notifications and clients that do not render blocks. */
  summary: z.string().min(1).max(SLACK_LIMITS.fallbackText).optional(),
});

export type SlackCardSpec = z.infer<typeof slackCardSchema>;
export type SlackCardBlock = SlackCardSpec['blocks'][number];

export type SlackCardParse = { ok: true; card: SlackCardSpec } | { ok: false; issues: string[] };

/**
 * Validate a model-produced spec (an object, or the JSON text of one). Never throws: every problem
 * comes back in `issues`, each a self-contained line naming the offending path, ready to be handed
 * back to the model verbatim.
 */
export function parseSlackCard(input: unknown, limits: SlackCardLimits = {}): SlackCardParse {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return { issues: ['spec is not valid JSON'], ok: false };
    }
  }

  const parsed = slackCardSchema.safeParse(value);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
      ok: false,
    };
  }

  const maxBlocks = Math.min(limits.maxBlocks ?? SLACK_LIMITS.maxBlocks, SLACK_LIMITS.maxBlocks);
  if (parsed.data.blocks.length > maxBlocks) {
    return {
      issues: [`blocks: at most ${maxBlocks} components allowed, got ${parsed.data.blocks.length}`],
      ok: false,
    };
  }

  const linkHosts = limits.allowedLinkHosts?.map((h) => h.toLowerCase());
  if (linkHosts) {
    const issues: string[] = [];
    for (const [i, block] of parsed.data.blocks.entries()) {
      if (block.type !== 'buttons') {
        continue;
      }
      for (const [j, item] of block.items.entries()) {
        const url = new URL(item.url);
        if (url.username || url.password || !linkHosts.includes(url.host.toLowerCase())) {
          issues.push(
            `blocks.${i}.items.${j}.url: links may only point at ${linkHosts.join(', ') || 'no host'}`
          );
        }
      }
    }
    if (issues.length > 0) {
      return { issues, ok: false };
    }
  }
  return { card: parsed.data, ok: true };
}

/** Escape the three characters Slack treats as markup, which also defuses mentions and links. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Aligned monospaced table body (no fence). Backticks are swapped so a cell cannot end the fence. */
function renderTableText(columns: string[], rows: string[][]): string {
  const cell = (value: string | undefined) =>
    clip((value ?? '').replace(/\s+/g, ' ').replace(/`/g, "'"), MAX_CELL_CHARS);
  const grid = [columns.map(cell), ...rows.map((row) => columns.map((_, i) => cell(row[i])))];
  const widths = columns.map((_, i) => Math.max(...grid.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) =>
    row
      .map((value, i) => value.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const [head, ...body] = grid;
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(head ?? []), rule, ...body.map(line)].join('\n');
}

function renderBlock(block: SlackCardBlock, index: number): Record<string, unknown> {
  switch (block.type) {
    case 'header':
      return {
        text: { emoji: true, text: block.text, type: 'plain_text' },
        type: 'header',
      };
    case 'text':
      return { text: { text: escapeSlackText(block.text), type: 'mrkdwn' }, type: 'section' };
    case 'context':
      return {
        elements: [{ text: escapeSlackText(block.text), type: 'mrkdwn' }],
        type: 'context',
      };
    case 'divider':
      return { type: 'divider' };
    case 'fields':
      return {
        fields: block.items.map((item) => ({
          text: `*${escapeSlackText(item.label)}*\n${escapeSlackText(item.value)}`,
          type: 'mrkdwn',
        })),
        type: 'section',
      };
    case 'table':
      return {
        text: {
          text: `\`\`\`\n${escapeSlackText(renderTableText(block.columns, block.rows))}\n\`\`\``,
          type: 'mrkdwn',
        },
        type: 'section',
      };
    case 'buttons':
      return {
        elements: block.items.map((item, i) => ({
          action_id: `card_link_${index}_${i}`,
          text: { emoji: true, text: item.label, type: 'plain_text' },
          type: 'button',
          url: item.url,
        })),
        type: 'actions',
      };
  }
}

/** Fallback text: the explicit summary, else the first header or text component, else a stub. */
function fallbackText(card: SlackCardSpec): string {
  if (card.summary) {
    return card.summary;
  }
  for (const block of card.blocks) {
    if (block.type === 'header' || block.type === 'text' || block.type === 'context') {
      return clip(block.text.replace(/\s+/g, ' '), SLACK_LIMITS.fallbackText);
    }
  }
  return 'auto-swe update';
}

/** Render an accepted card: `blocks` for Slack's `blocks` field, `text` for its `text` field. */
export function renderSlackCard(card: SlackCardSpec): { blocks: unknown[]; text: string } {
  return {
    blocks: card.blocks.map((block, i) => renderBlock(block, i)),
    text: escapeSlackText(fallbackText(card)),
  };
}

/**
 * The catalog, written for a system prompt. It describes exactly what `slackCardSchema` accepts;
 * `slackCard.test.ts` checks that every component type named here parses.
 */
export function slackCardPrompt(options: { linkHosts?: readonly string[] } = {}): string {
  return [
    'To reply with a structured Slack card, answer with one JSON object and nothing else:',
    '{ "summary"?: string, "blocks": Component[] }',
    `"summary" is a plain-text fallback (max ${SLACK_LIMITS.fallbackText} chars). "blocks" holds 1-${SLACK_LIMITS.maxBlocks} components, each with a "type":`,
    `- { "type": "header", "text": string }  (max ${SLACK_LIMITS.headerText} chars, plain text)`,
    `- { "type": "text", "text": string }  (max ${SLACK_LIMITS.sectionText} chars; Slack *bold* and _italic_ allowed)`,
    '- { "type": "fields", "items": [{ "label": string, "value": string }] }  (1-10 label/value pairs)',
    `- { "type": "table", "columns": string[], "rows": string[][] }  (max ${MAX_TABLE_COLUMNS} columns, ${MAX_TABLE_ROWS} rows; every row has one cell per column; cells over ${MAX_CELL_CHARS} chars are cut)`,
    '- { "type": "context", "text": string }  (small grey footnote)',
    '- { "type": "divider" }',
    `- { "type": "buttons", "items": [{ "label": string, "url": string }] }  (1-${SLACK_LIMITS.buttonsPerBlock} link buttons; http(s) URLs only)`,
    'Text is shown literally: <, > and & are escaped, so mentions and links written inline do not work. Put links in "buttons".',
    ...(options.linkHosts
      ? [`Button URLs may only use these hosts: ${options.linkHosts.join(', ') || '(none)'}.`]
      : []),
  ].join('\n');
}
