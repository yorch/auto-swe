// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry } from '@/lib/modelCatalog';

// vi.mock is hoisted above the file's declarations, so its fixtures are too.
const { ENTRIES, discoverMutate, dismissMutate, mutation, suggestion } = vi.hoisted(() => {
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

  function suggestion(over: Record<string, unknown>) {
    return {
      dismissedAt: null,
      displayName: null,
      firstSeenAt: '2026-10-01T04:00:00Z',
      kind: 'CHAT',
      lastSeenAt: '2026-10-02T04:00:00Z',
      type: 'NEW',
      ...over,
      spec: `${over.provider}/${over.modelId}`,
    };
  }

  return { ENTRIES, discoverMutate: vi.fn(), dismissMutate: vi.fn(), mutation, suggestion };
});

vi.mock('@/hooks/useModelCatalog', () => ({
  useCreateCatalogEntry: mutation,
  useDeleteCatalogEntry: mutation,
  useDismissSuggestion: () => ({ isPending: false, mutate: dismissMutate }),
  useDiscoverModels: () => ({ error: null, isPending: false, mutate: discoverMutate }),
  useModelSuggestions: () => ({
    data: {
      providers: [
        {
          checkedAt: '2026-10-02T04:00:00Z',
          error: 'HTTP 401',
          lastSuccessAt: '2026-10-01T04:00:00Z',
          provider: 'anthropic',
        },
        {
          checkedAt: '2026-10-02T04:00:00Z',
          error: null,
          lastSuccessAt: '2026-10-02T04:00:00Z',
          provider: 'ollama',
        },
      ],
      suggestions: [
        // Already in the catalog: added since the last run, so it is hidden.
        suggestion({ id: 's0', modelId: 'llama-4', provider: 'ollama' }),
        suggestion({
          displayName: 'Nomic Embed',
          id: 's1',
          kind: 'EMBEDDING',
          modelId: 'nomic-embed-2',
          provider: 'ollama',
        }),
        suggestion({
          id: 's2',
          modelId: 'claude-sonnet-5-5',
          provider: 'anthropic',
          type: 'RETIREMENT_CANDIDATE',
        }),
      ],
    },
    error: null,
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

/** The row for a spec; a possibly-retired model also appears in the flag list, which this skips. */
function rowFor(spec: string): HTMLElement {
  const row = screen
    .getAllByText(spec)
    .map((el) => el.closest('tr'))
    .find((tr) => tr && !tr.textContent?.includes('not listed since'));
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

  it('shows stored suggestions with last-checked and a failed provider’s error, hiding what the catalog has', () => {
    render(<CatalogTab />);
    expect(screen.getByText(/anthropic: could not list models \(HTTP 401\)/)).toBeTruthy();
    expect(screen.getByText(/Last checked/)).toBeTruthy();
    expect(screen.getByText('ollama/nomic-embed-2')).toBeTruthy();
    // ollama/llama-4 appears once — in the catalog table, not again as "new".
    expect(screen.getAllByText('ollama/llama-4')).toHaveLength(1);
  });

  it('runs a check on demand and dismisses a suggestion', () => {
    render(<CatalogTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Check providers now' }));
    expect(discoverMutate).toHaveBeenCalled();
    fireEvent.click(
      within(rowFor('ollama/nomic-embed-2')).getByRole('button', { name: 'Dismiss' })
    );
    expect(dismissMutate).toHaveBeenCalledWith({ dismiss: true, id: 's1' });
  });

  it('lists possibly retired models apart, with an edit and no retire action', () => {
    render(<CatalogTab />);
    expect(screen.getByText('Priced, but no longer listed')).toBeTruthy();
    // The flagged row appears in the catalog table and in the flag list.
    const flagged = screen
      .getAllByText('anthropic/claude-sonnet-5-5')
      .map((el) => el.closest('tr'))
      .find((tr) => tr && within(tr).queryByText(/not listed since/));
    expect(flagged).toBeTruthy();
    expect(within(flagged as HTMLElement).queryByRole('button', { name: /retire/i })).toBeNull();
    fireEvent.click(within(flagged as HTMLElement).getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Edit anthropic/claude-sonnet-5-5')).toBeTruthy();
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
