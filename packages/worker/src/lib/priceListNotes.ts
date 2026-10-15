import { lookupPriceList, type PriceTable } from '@auto-swe/shared/lib/modelPriceList';

/**
 * The catalog refresh's price-list rule, checked in code: every row the change
 * adds, or whose price it changes, either matches the community price list or
 * carries a `// price list says …` comment for the reviewer. The prompt states
 * the rule; this is what makes a run that ignores it go back for a fix.
 *
 * Pure: it reads two versions of the catalog file as text and a loaded list.
 */

/** The marker a row carries when its price knowingly differs from the list's. */
export const PRICE_LIST_NOTE = 'price list says';

export interface CatalogPriceRow {
  provider: string;
  modelId: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** True when the row, or the line just before it, carries {@link PRICE_LIST_NOTE}. */
  noted: boolean;
}

export interface UnnotedRow {
  spec: string;
  catalog: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  list: { inputUsdPerMTok: number; outputUsdPerMTok: number };
}

const num = (block: string, key: string): number | null => {
  const m = new RegExp(`\\b${key}:\\s*(-?[0-9][0-9_]*(?:\\.[0-9_]+)?(?:e-?[0-9]+)?)`).exec(block);
  return m?.[1] ? Number(m[1].replace(/_/g, '')) : null;
};

/**
 * Every row of a catalog file with a provider, an id and both prices. A row is
 * one `{ … }` object literal; its note may sit inside it, at the end of its
 * closing line, or on the line just above it.
 */
export function parseCatalogPrices(source: string): CatalogPriceRow[] {
  const rows: CatalogPriceRow[] = [];
  for (const match of source.matchAll(/\{[^{}]*\}[^\n]*/g)) {
    const block = match[0];
    const provider = /\bprovider:\s*'([a-z0-9._-]+)'/.exec(block)?.[1];
    const modelId = /\bmodelId:\s*'([A-Za-z0-9._/-]+)'/.exec(block)?.[1];
    const input = num(block, 'inputUsdPerMTok');
    const output = num(block, 'outputUsdPerMTok');
    if (!provider || !modelId || input === null || output === null) {
      continue;
    }
    // Only a comment-only line counts: the line above may also be the previous
    // row's closing line, whose own note is not this row's.
    const before = source.slice(0, match.index);
    const lastNewline = before.lastIndexOf('\n');
    const lineAbove = before.slice(before.lastIndexOf('\n', lastNewline - 1) + 1, lastNewline);
    const noteAbove = lineAbove.trim().startsWith('//') && lineAbove.includes(PRICE_LIST_NOTE);
    rows.push({
      inputUsdPerMTok: input,
      modelId,
      noted: block.includes(PRICE_LIST_NOTE) || noteAbove,
      outputUsdPerMTok: output,
      provider,
    });
  }
  return rows;
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/**
 * The rows `head` adds or reprices relative to `base` whose price differs from
 * the list's and carries no note. A row the list does not price is never
 * flagged, and neither is an unchanged row: the rule is about this change.
 */
export function findUnnotedPriceRows(base: string, head: string, table: PriceTable): UnnotedRow[] {
  const before = new Map<string, CatalogPriceRow>(
    parseCatalogPrices(base).map((r) => [`${r.provider}/${r.modelId}`, r])
  );
  const out: UnnotedRow[] = [];
  for (const row of parseCatalogPrices(head)) {
    const spec = `${row.provider}/${row.modelId}`;
    const prior = before.get(spec);
    const changed =
      !prior ||
      !same(prior.inputUsdPerMTok, row.inputUsdPerMTok) ||
      !same(prior.outputUsdPerMTok, row.outputUsdPerMTok);
    if (!changed || row.noted) {
      continue;
    }
    const listed = lookupPriceList(table, row.provider, row.modelId);
    if (
      !listed ||
      (same(listed.inputUsdPerMTok, row.inputUsdPerMTok) &&
        same(listed.outputUsdPerMTok, row.outputUsdPerMTok))
    ) {
      continue;
    }
    out.push({
      catalog: { inputUsdPerMTok: row.inputUsdPerMTok, outputUsdPerMTok: row.outputUsdPerMTok },
      list: { inputUsdPerMTok: listed.inputUsdPerMTok, outputUsdPerMTok: listed.outputUsdPerMTok },
      spec,
    });
  }
  return out.sort((a, b) => a.spec.localeCompare(b.spec));
}

/**
 * The finding the review fixer receives, in fixed words: only specs (already
 * plain tokens from the file) and numbers formatted here.
 */
export function unnotedRowsSummary(rows: UnnotedRow[]): string {
  const lines = rows.map(
    (r) =>
      `- ${r.spec}: the change sets $${r.catalog.inputUsdPerMTok} / $${r.catalog.outputUsdPerMTok}; ` +
      `the price list says $${r.list.inputUsdPerMTok} / $${r.list.outputUsdPerMTok}.`
  );
  return (
    'These rows were added or repriced with figures that differ from the community price list, ' +
    `and carry no \`// ${PRICE_LIST_NOTE} …\` comment:\n\n${lines.join('\n')}\n\n` +
    "For each, fetch the official pricing page again. If the page shows the figure you set, keep it and add `// price list says $<input> / $<output>` (the list's figures) on that row. " +
    'If it does not, set the figure the page shows, or leave the row as it was and mark it UNVERIFIED.'
  );
}
