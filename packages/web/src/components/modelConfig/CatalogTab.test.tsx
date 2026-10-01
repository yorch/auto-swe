// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry } from '@/lib/modelCatalog';

// vi.mock is hoisted above the file's declarations, so its fixtures are too.
const { ENTRIES, mutation } = vi.hoisted(() => {
  const BUILTIN = {
    inputUsdPerMTok: 4,
    kind: 'CHAT' as const,
    outputUsdPerMTok: 20,
    status: 'ACTIVE' as const,
  };

  function entry(over: Partial<ModelCatalogEntry>): ModelCatalogEntry {
    return {
      builtin: null,
      displayName: null,
      id: 'id',
      inputUsdPerMTok: 4,
      isBuiltIn: false,
      isCustomized: false,
      kind: 'CHAT',
      modelId: 'm',
      notes: null,
      outputUsdPerMTok: 20,
      provider: 'p',
      status: 'ACTIVE',
      ...over,
    };
  }

  const ENTRIES = [
    entry({
      builtin: BUILTIN,
      id: 'a',
      isBuiltIn: true,
      modelId: 'claude-opus-5-5',
      provider: 'anthropic',
    }),
    entry({
      builtin: BUILTIN,
      id: 'b',
      inputUsdPerMTok: 3.5,
      isBuiltIn: true,
      isCustomized: true,
      modelId: 'claude-sonnet-5-5',
      outputUsdPerMTok: 17,
      provider: 'anthropic',
    }),
    entry({
      id: 'c',
      inputUsdPerMTok: 0,
      modelId: 'llama-4',
      outputUsdPerMTok: 0,
      provider: 'ollama',
    }),
  ];

  const mutation = () => ({ isPending: false, mutate: vi.fn(), mutateAsync: vi.fn() });
  return { ENTRIES, mutation };
});

vi.mock('@/hooks/useModelCatalog', () => ({
  useCreateCatalogEntry: mutation,
  useDeleteCatalogEntry: mutation,
  useDiscoverModels: () => ({
    data: [
      { error: 'HTTP 401', models: [], ok: false, provider: 'anthropic' },
      {
        models: [
          // Already in the catalog: added since the check, so it is hidden.
          { displayName: null, kind: 'CHAT', modelId: 'llama-4', spec: 'ollama/llama-4' },
          {
            displayName: 'Nomic Embed',
            kind: 'EMBEDDING',
            modelId: 'nomic-embed-2',
            spec: 'ollama/nomic-embed-2',
          },
        ],
        ok: true,
        provider: 'ollama',
      },
    ],
    error: null,
    isPending: false,
    mutate: vi.fn(),
  }),
  useModelCatalog: () => ({ data: ENTRIES, error: null, isError: false, isLoading: false }),
  useResetCatalogEntry: mutation,
  useUnpricedModels: () => ({
    data: [{ spec: 'openai/gpt-5-5', suggestion: 'openai/gpt-5.5', usedBy: ['agent:reviewer'] }],
  }),
  useUpdateCatalogEntry: mutation,
}));

import { CatalogTab } from './CatalogTab';

// jsdom implements <dialog> without showModal()/close().
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

function rowFor(spec: string): HTMLElement {
  const row = screen.getByText(spec).closest('tr');
  if (!row) {
    throw new Error(`no row for ${spec}`);
  }
  return row;
}

describe('CatalogTab', () => {
  it('marks each row built-in, customized or custom, and prices a 0/0 model as free', () => {
    render(<CatalogTab />);
    expect(within(rowFor('anthropic/claude-opus-5-5')).getByText('built-in')).toBeTruthy();
    expect(within(rowFor('anthropic/claude-sonnet-5-5')).getByText('customized')).toBeTruthy();
    const local = rowFor('ollama/llama-4');
    expect(within(local).getByText('custom')).toBeTruthy();
    expect(within(local).getByText('free')).toBeTruthy();
  });

  it('shows what code now ships only on a customized row that diverges, with a reset', () => {
    render(<CatalogTab />);
    const customized = rowFor('anthropic/claude-sonnet-5-5');
    expect(within(customized).getByText(/built-in is now \$4 \/ \$20 per MTok/)).toBeTruthy();
    expect(within(customized).getByRole('button', { name: 'Reset' })).toBeTruthy();
    const untouched = rowFor('anthropic/claude-opus-5-5');
    expect(within(untouched).queryByText(/built-in is now/)).toBeNull();
    expect(within(untouched).queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('only offers delete on a custom row — a built-in one would come back at startup', () => {
    render(<CatalogTab />);
    expect(
      within(rowFor('anthropic/claude-opus-5-5')).queryByRole('button', { name: 'Delete' })
    ).toBeNull();
    expect(within(rowFor('ollama/llama-4')).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  it('lists unpriced models with their likely intended spec, and prefills an add from one', () => {
    render(<CatalogTab />);
    const unpriced = rowFor('openai/gpt-5-5');
    expect(within(unpriced).getByText('openai/gpt-5.5')).toBeTruthy();
    fireEvent.click(within(unpriced).getByRole('button', { name: 'Add to catalog' }));
    expect(screen.getByLabelText(/^Provider/)).toHaveProperty('value', 'openai');
    expect(screen.getByLabelText(/^Model id/)).toHaveProperty('value', 'gpt-5-5');
  });

  it("shows each provider's discovery result, hiding what the catalog already has", () => {
    render(<CatalogTab />);
    expect(screen.getByText(/Could not list models: HTTP 401/)).toBeTruthy();
    expect(screen.getByText('ollama/nomic-embed-2')).toBeTruthy();
    // ollama/llama-4 appears once — in the catalog table, not again as "new".
    expect(screen.getAllByText('ollama/llama-4')).toHaveLength(1);
  });

  it('prefills an add from a discovered model, keeping its kind and display name', () => {
    render(<CatalogTab />);
    fireEvent.click(within(rowFor('ollama/nomic-embed-2')).getByRole('button', { name: 'Add' }));
    expect(screen.getByLabelText(/^Provider/)).toHaveProperty('value', 'ollama');
    expect(screen.getByLabelText(/^Model id/)).toHaveProperty('value', 'nomic-embed-2');
    expect(screen.getByLabelText(/^Display name/)).toHaveProperty('value', 'Nomic Embed');
    expect(screen.getByText('Embedding models bill input only — use 0.')).toBeTruthy();
  });
});
