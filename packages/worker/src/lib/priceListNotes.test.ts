import { describe, expect, it } from 'vitest';
import { findUnnotedPriceRows, parseCatalogPrices, unnotedRowsSummary } from './priceListNotes.js';

const row = (modelId: string, input: number, output: number, extra = '') => `  {
    inputUsdPerMTok: ${input},
    kind: 'CHAT',
    modelId: '${modelId}',
    outputUsdPerMTok: ${output},
    provider: 'openai',${extra}
  },`;
const file = (...rows: string[]) => `export const BUILTIN_MODELS = [\n${rows.join('\n')}\n];\n`;

const entry = (input: number, output: number) => ({
  input_cost_per_token: input / 1e6,
  litellm_provider: 'openai',
  mode: 'chat',
  output_cost_per_token: output / 1e6,
});
const TABLE = { 'gpt-a': entry(2, 8), 'gpt-b': entry(1, 4), 'gpt-c': entry(5, 20) };

describe('parseCatalogPrices', () => {
  it('reads each row, with its note inside, after its closing brace, or on a comment line above', () => {
    const src = file(
      row('gpt-a', 2, 8, '\n    // price list says $3 / $9'),
      `${row('gpt-b', 1, 4)} // price list says $1 / $5`,
      '  // price list says $9 / $9',
      row('gpt-c', 5, 20),
      row('gpt-d', 1_000, 0.5)
    );
    expect(parseCatalogPrices(src)).toEqual([
      {
        inputUsdPerMTok: 2,
        modelId: 'gpt-a',
        noted: true,
        outputUsdPerMTok: 8,
        provider: 'openai',
      },
      {
        inputUsdPerMTok: 1,
        modelId: 'gpt-b',
        noted: true,
        outputUsdPerMTok: 4,
        provider: 'openai',
      },
      {
        inputUsdPerMTok: 5,
        modelId: 'gpt-c',
        noted: true,
        outputUsdPerMTok: 20,
        provider: 'openai',
      },
      {
        inputUsdPerMTok: 1000,
        modelId: 'gpt-d',
        noted: false,
        outputUsdPerMTok: 0.5,
        provider: 'openai',
      },
    ]);
  });

  it("never credits a row with the previous row's trailing note", () => {
    const src = file(`${row('gpt-a', 2, 8)} // price list says $1 / $1`, row('gpt-b', 1, 4));
    expect(parseCatalogPrices(src).map((r) => r.noted)).toEqual([true, false]);
  });
});

describe('findUnnotedPriceRows', () => {
  it('flags an added or repriced row that differs from the list without a note', () => {
    const base = file(row('gpt-a', 2, 8), row('gpt-b', 1, 4));
    const head = file(row('gpt-a', 2.5, 8), row('gpt-b', 1, 4), row('gpt-c', 6, 20));
    expect(findUnnotedPriceRows(base, head, TABLE)).toEqual([
      {
        catalog: { inputUsdPerMTok: 2.5, outputUsdPerMTok: 8 },
        list: { inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
        spec: 'openai/gpt-a',
      },
      {
        catalog: { inputUsdPerMTok: 6, outputUsdPerMTok: 20 },
        list: { inputUsdPerMTok: 5, outputUsdPerMTok: 20 },
        spec: 'openai/gpt-c',
      },
    ]);
  });

  it('passes a noted difference, a match with the list, an unchanged row, and an unlisted model', () => {
    const base = file(row('gpt-b', 7, 7));
    const head = file(
      row('gpt-a', 9, 9, '\n    // price list says $2 / $8'),
      row('gpt-b', 7, 7),
      row('gpt-c', 5, 20),
      row('gpt-unlisted', 1, 1)
    );
    expect(findUnnotedPriceRows(base, head, TABLE)).toEqual([]);
  });

  it('says what to do in fixed words, naming only specs and numbers', () => {
    const summary = unnotedRowsSummary([
      {
        catalog: { inputUsdPerMTok: 2.5, outputUsdPerMTok: 8 },
        list: { inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
        spec: 'openai/gpt-a',
      },
    ]);
    expect(summary).toContain(
      '- openai/gpt-a: the change sets $2.5 / $8; the price list says $2 / $8.'
    );
    expect(summary).toContain('// price list says $<input> / $<output>');
  });
});
