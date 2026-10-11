// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSearchIndex, MAX_QUERY_CHARS, type SearchResult, searchDocs } from '@/lib/docSearch';
import type { DocMeta } from '@/lib/docs';
import { DocsIndex, fetchSearchResults, SEARCH_DEBOUNCE_MS } from './DocsIndex';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const DOCS: DocMeta[] = [
  { description: 'How agents work', slug: 'agents', title: 'Agents' },
  { description: 'Money and limits', slug: 'budgets', title: 'Budgets' },
];

const INDEX = buildSearchIndex([
  {
    content: '# Agents\n\n## Skills\n\nA skill is a prompt fragment with `<b>raw</b>` markup.\n',
    slug: 'agents',
    title: 'Agents',
  },
  { content: '# Budgets\n\n## Limits\n\nTokens are capped.\n', slug: 'budgets', title: 'Budgets' },
]);

/** A stand-in for the server: the real search over a small index. */
const serverSearch = () => vi.fn((q: string) => Promise.resolve(searchDocs(INDEX, q)));

function type(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search docs' }), { target: { value } });
}

/** Let the debounce elapse and the mocked request settle. */
async function settle(ms = SEARCH_DEBOUNCE_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('DocsIndex search', () => {
  it('requests nothing until the reader types, and nothing for blank input', async () => {
    const search = serverSearch();
    render(<DocsIndex docs={DOCS} search={search} />);
    fireEvent.focus(screen.getByRole('searchbox', { name: 'Search docs' }));
    type('   ');
    await settle(1000);
    expect(search).not.toHaveBeenCalled();
  });

  it('waits for typing to pause, then makes one request for the final text', async () => {
    const search = serverSearch();
    render(<DocsIndex docs={DOCS} search={search} />);
    type('s');
    await settle(SEARCH_DEBOUNCE_MS - 50);
    type('sk');
    await settle(SEARCH_DEBOUNCE_MS - 50);
    type('skill');
    expect(search).not.toHaveBeenCalled();
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toBe('skill');
  });

  it('aborts the request in flight when the next keystroke arrives, and ignores its answer', async () => {
    const signals: AbortSignal[] = [];
    let resolveFirst: (r: SearchResult[]) => void = () => {};
    const search = vi.fn((q: string, signal: AbortSignal) => {
      signals.push(signal);
      if (q === 'prompt') {
        return new Promise<SearchResult[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(searchDocs(INDEX, q));
    });
    render(<DocsIndex docs={DOCS} search={search} />);
    type('prompt');
    await settle();
    expect(signals[0]?.aborted).toBe(false);
    type('limits');
    expect(signals[0]?.aborted).toBe(true);
    await settle();
    // The cancelled request answers late with a result that must not appear.
    await act(async () => resolveFirst(searchDocs(INDEX, 'prompt')));
    expect(screen.queryByRole('link', { name: /Agents.*Skills/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Budgets.*Limits/ })).toBeTruthy();
  });

  it('cancels a pending request when the box is cleared', async () => {
    const search = serverSearch();
    render(<DocsIndex docs={DOCS} search={search} />);
    type('prompt');
    type('');
    await settle(1000);
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('2 docs');
  });

  it('filters titles instantly, before the server answers', () => {
    const search = vi.fn(() => new Promise<SearchResult[]>(() => {}));
    render(<DocsIndex docs={DOCS} search={search} />);
    type('budg');
    expect(screen.getByRole('link', { name: /Budgets/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Agents/ })).toBeNull();
    expect(screen.getByText(/Searching the doc text/)).toBeTruthy();
    expect(screen.queryByText('No docs match "budg"')).toBeNull();
  });

  it('shows section results with highlighted terms and a deep link', async () => {
    render(<DocsIndex docs={DOCS} search={serverSearch()} />);
    type('prompt');
    await settle();
    const link = screen.getByRole('link', { name: /Agents.*Skills/ });
    expect(link.getAttribute('href')).toBe('/docs/agents#skills');
    expect([...document.querySelectorAll('mark')].map((m) => m.textContent)).toContain('prompt');
    expect(screen.getByRole('status').textContent).toBe('0 title matches, 1 section in the text');
  });

  it('finds a stemmed form and highlights the original word', async () => {
    render(<DocsIndex docs={DOCS} search={serverSearch()} />);
    type('capping');
    await settle();
    expect(screen.getByRole('link', { name: /Budgets.*Limits/ })).toBeTruthy();
    expect([...document.querySelectorAll('mark')].map((m) => m.textContent)).toContain('capped');
  });

  it('renders matched markup as text, never as elements', async () => {
    render(<DocsIndex docs={DOCS} search={serverSearch()} />);
    type('raw');
    await settle();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByText(/<b>/)).toBeTruthy();
  });

  it('announces searching, then the result count, in a polite live region', async () => {
    render(<DocsIndex docs={DOCS} search={serverSearch()} />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('2 docs');
    type('limits');
    // Nothing is announced while the search runs; the visible text is hidden from assistive tech.
    expect(status.textContent).toBe('');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText(/Searching the doc text…/).getAttribute('aria-hidden')).toBe('true');
    await settle();
    expect(status.textContent).toContain('1 section in the text');
    expect(status.getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByText(/Searching the doc text…/)).toBeNull();
  });

  it('does not re-announce while typing continues', async () => {
    render(<DocsIndex docs={DOCS} search={serverSearch()} />);
    const status = screen.getByRole('status');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(status.textContent ?? ''));
    observer.observe(status, { characterData: true, childList: true, subtree: true });
    for (const v of ['l', 'li', 'lim', 'limi', 'limit']) {
      type(v);
    }
    await Promise.resolve();
    expect(seen.filter((t) => t !== '')).toEqual([]);
    await settle();
    await Promise.resolve();
    observer.disconnect();
    expect(seen.filter((t) => t !== '')).toHaveLength(1); // one announcement, when it settled
    expect(status.textContent).toContain('in the text');
  });

  it('does not show the previous answer under a newer query while it is searching', async () => {
    render(<DocsIndex docs={DOCS} search={serverSearch()} />);
    type('prompt');
    await settle();
    expect(screen.getByRole('link', { name: /Agents.*Skills/ })).toBeTruthy();
    type('limits');
    expect(screen.queryByRole('link', { name: /Agents.*Skills/ })).toBeNull();
    expect(screen.queryByText(/In the text/)).toBeNull();
  });

  it('sends at most MAX_QUERY_CHARS characters, trimmed', async () => {
    const search = serverSearch();
    render(<DocsIndex docs={DOCS} search={search} />);
    type(`  ${'a'.repeat(MAX_QUERY_CHARS + 50)}  `);
    await settle();
    expect(search.mock.calls[0]?.[0]).toBe('a'.repeat(MAX_QUERY_CHARS));
  });

  it('shows the empty state when neither titles nor text match', async () => {
    render(<DocsIndex docs={DOCS} search={serverSearch()} />);
    type('zzzz');
    expect(screen.queryByText('No docs match "zzzz"')).toBeNull(); // not before the server has answered
    await settle();
    expect(screen.getByText('No docs match "zzzz"')).toBeTruthy();
  });

  it('falls back to title filtering with a message when the request fails', async () => {
    const search = vi.fn(() => Promise.reject(new Error('boom')));
    render(<DocsIndex docs={DOCS} search={search} />);
    type('agents');
    await settle();
    expect(screen.getByRole('status').textContent).toContain(
      'Searching the doc text is unavailable'
    );
    expect(screen.getByRole('link', { name: /Agents/ })).toBeTruthy();
    expect(screen.queryByText(/In the text/)).toBeNull();
  });

  it('still shows the empty state after a failed request with no title match', async () => {
    render(<DocsIndex docs={DOCS} search={() => Promise.reject(new Error('boom'))} />);
    type('zzzz');
    await settle();
    expect(screen.getByText('No docs match "zzzz"')).toBeTruthy();
  });

  it('retries on the next keystroke after a failure, and not by itself', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation((q: string) => Promise.resolve(searchDocs(INDEX, q)));
    render(<DocsIndex docs={DOCS} search={search} />);
    type('prompt');
    await settle();
    expect(screen.getByRole('status').textContent).toContain('unavailable');
    await settle(5000);
    expect(search).toHaveBeenCalledTimes(1);
    type('prompts');
    await settle();
    expect(search).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: /Agents.*Skills/ })).toBeTruthy();
  });
});

describe('fetchSearchResults', () => {
  const json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      ...init,
    });

  it('requests /docs/search with the encoded query and the abort signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await expect(fetchSearchResults('a b&c', controller.signal)).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/docs/search?q=a+b%26c');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });

  it('returns the results', async () => {
    const results = searchDocs(INDEX, 'limits');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ results })));
    await expect(fetchSearchResults('limits')).resolves.toEqual(results);
  });

  it('rejects on a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'x' }, { status: 500 })));
    await expect(fetchSearchResults('x')).rejects.toThrow();
  });

  it('rejects a body that is not a result list, as after a login redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })
        )
    );
    await expect(fetchSearchResults('x')).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ x: 1 })));
    await expect(fetchSearchResults('x')).rejects.toThrow();
  });
});
