import { describe, expect, it } from 'vitest';
import {
  divergesFromBuiltin,
  estimatorPricing,
  formatPrice,
  type ModelCatalogEntry,
  modelSpecOptions,
} from './modelCatalog';

function entry(over: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    builtin: null,
    displayName: null,
    id: 'id',
    inputUsdPerMTok: 4,
    isBuiltIn: false,
    isCustomized: false,
    kind: 'CHAT',
    modelId: 'claude-opus-5-5',
    notes: null,
    outputUsdPerMTok: 20,
    provider: 'anthropic',
    status: 'ACTIVE',
    ...over,
  };
}

describe('formatPrice', () => {
  it('shows input and output for a chat model, input only for an embedding model', () => {
    expect(formatPrice(entry({}))).toBe('$4 / $20 per MTok');
    expect(
      formatPrice(entry({ inputUsdPerMTok: 0.13, kind: 'EMBEDDING', outputUsdPerMTok: 0 }))
    ).toBe('$0.13 per MTok');
  });

  it('calls a 0/0 model free, rather than $0 — it is known, not unpriced', () => {
    expect(formatPrice(entry({ inputUsdPerMTok: 0, outputUsdPerMTok: 0 }))).toBe('free');
  });
});

describe('modelSpecOptions', () => {
  it('lists active models first, labels deprecated ones, and leaves retired ones out', () => {
    const options = modelSpecOptions([
      entry({ modelId: 'old', status: 'DEPRECATED' }),
      entry({ modelId: 'gone', status: 'RETIRED' }),
      entry({ modelId: 'zeta' }),
      entry({ modelId: 'alpha', provider: 'openai' }),
    ]);
    expect(options.map((o) => o.value)).toEqual([
      'anthropic/zeta',
      'openai/alpha',
      'anthropic/old',
    ]);
    expect(options[2]?.description).toBe('deprecated · $4 / $20 per MTok');
  });

  it("uses the spec as the option's text, as a custom-value picker requires", () => {
    const [option] = modelSpecOptions([entry({})]);
    expect(option?.label).toBe(option?.value);
  });
});

describe('divergesFromBuiltin', () => {
  const builtin = {
    inputUsdPerMTok: 4,
    kind: 'CHAT' as const,
    outputUsdPerMTok: 20,
    status: 'ACTIVE' as const,
  };

  it('flags a customized built-in whose shipped price has since changed', () => {
    expect(
      divergesFromBuiltin(
        entry({ builtin, inputUsdPerMTok: 3.5, isBuiltIn: true, isCustomized: true })
      )
    ).toBe(true);
  });

  it('is quiet for an uncustomized row, a matching one, or a custom model', () => {
    expect(divergesFromBuiltin(entry({ builtin, inputUsdPerMTok: 3.5, isBuiltIn: true }))).toBe(
      false
    );
    expect(divergesFromBuiltin(entry({ builtin, isBuiltIn: true, isCustomized: true }))).toBe(
      false
    );
    expect(divergesFromBuiltin(entry({ isCustomized: true }))).toBe(false);
  });
});

describe('estimatorPricing', () => {
  it("maps each role's live price onto the estimator's rate shape", () => {
    expect(
      estimatorPricing({
        implementer: {
          inputUsdPerMTok: 4,
          modelSpec: 'anthropic/claude-opus-5-5',
          outputUsdPerMTok: 20,
        },
      })
    ).toEqual({ implementer: { inputUsdPerM: 4, outputUsdPerM: 20 } });
  });
});
