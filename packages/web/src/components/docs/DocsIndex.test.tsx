// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSearchIndex, type SearchIndex } from '@/lib/docSearch';
import type { DocMeta } from '@/lib/docs';
import { DocsIndex, fetchSearchIndex } from './DocsIndex';

afterEach(cleanup);

const DOCS: DocMeta[] = [
  { description: 'How agents work', slug: 'agents', title: 'Agents' },
  { description: 'Money and limits', slug: 'budgets', title: 'Budgets' },
];

const INDEX: SearchIndex = buildSearchIndex([
  {
    content: '# Agents\n\n## Skills\n\nA skill is a prompt fragment with `<b>raw</b>` markup.\n',
    slug: 'agents',
    title: 'Agents',
  },
  { content: '# Budgets\n\n## Limits\n\nTokens are capped.\n', slug: 'budgets', title: 'Budgets' },
]);

function type(value: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search docs' }), { target: { value } });
}

describe('DocsIndex search', () => {
  it('does not fetch the index until the reader focuses or types', () => {
    const loadIndex = vi.fn().mockResolvedValue(INDEX);
    render(<DocsIndex docs={DOCS} loadIndex={loadIndex} />);
    expect(loadIndex).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByRole('searchbox', { name: 'Search docs' }));
    expect(loadIndex).toHaveBeenCalledTimes(1);
    type('skill');
    type('skills');
    expect(loadIndex).toHaveBeenCalledTimes(1);
  });

  it('retries a failed index fetch on the next user action, and not in a loop', async () => {
    const loadIndex = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(INDEX);
    render(<DocsIndex docs={DOCS} loadIndex={loadIndex} />);
    type('prompt');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('unavailable'));
    // Settling into the error state does not fetch again by itself.
    expect(loadIndex).toHaveBeenCalledTimes(1);
    type('prompts');
    await waitFor(() => expect(loadIndex).toHaveBeenCalledTimes(2));
    type('prompt');
    await screen.findByRole('link', { name: /Agents.*Skills/ });
    expect(loadIndex).toHaveBeenCalledTimes(2);
  });

  it('filters titles instantly, before the index arrives', () => {
    const loadIndex = vi.fn(() => new Promise<SearchIndex>(() => {}));
    render(<DocsIndex docs={DOCS} loadIndex={loadIndex} />);
    type('budg');
    expect(screen.getByRole('link', { name: /Budgets/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Agents/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Searching the doc text');
    expect(screen.queryByText('No docs match "budg"')).toBeNull();
  });

  it('shows section results with highlighted terms and a deep link', async () => {
    render(<DocsIndex docs={DOCS} loadIndex={() => Promise.resolve(INDEX)} />);
    type('prompt');
    const link = await screen.findByRole('link', { name: /Agents.*Skills/ });
    expect(link.getAttribute('href')).toBe('/docs/agents#skills');
    const marks = [...document.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toContain('prompt');
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('0 title matches, 1 section in the text')
    );
  });

  it('renders matched markup as text, never as elements', async () => {
    render(<DocsIndex docs={DOCS} loadIndex={() => Promise.resolve(INDEX)} />);
    type('raw');
    await screen.findByRole('link', { name: /Agents/ });
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByText(/<b>/)).toBeTruthy();
  });

  it('announces the result count in a polite live region', async () => {
    render(<DocsIndex docs={DOCS} loadIndex={() => Promise.resolve(INDEX)} />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('2 docs');
    type('limits');
    await waitFor(() => expect(status.textContent).toContain('1 section in the text'));
  });

  it('shows the empty state when neither titles nor text match', async () => {
    render(<DocsIndex docs={DOCS} loadIndex={() => Promise.resolve(INDEX)} />);
    type('zzzz');
    expect(await screen.findByText('No docs match "zzzz"')).toBeTruthy();
  });

  it('falls back to title filtering with a message when the fetch fails', async () => {
    render(<DocsIndex docs={DOCS} loadIndex={() => Promise.reject(new Error('boom'))} />);
    type('agents');
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Searching the doc text is unavailable'
      )
    );
    expect(screen.getByRole('link', { name: /Agents/ })).toBeTruthy();
    expect(screen.queryByText(/In the text/)).toBeNull();
  });

  it('still shows the empty state after a failed fetch with no title match', async () => {
    render(<DocsIndex docs={DOCS} loadIndex={() => Promise.reject(new Error('boom'))} />);
    type('zzzz');
    expect(await screen.findByText('No docs match "zzzz"')).toBeTruthy();
  });
});

describe('fetchSearchIndex', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the parsed index', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(INDEX))));
    await expect(fetchSearchIndex()).resolves.toEqual(INDEX);
  });

  it('rejects on a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));
    await expect(fetchSearchIndex()).rejects.toThrow();
  });

  it('rejects when the body is not an index, as after a login redirect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>login</html>')));
    await expect(fetchSearchIndex()).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"x":1}')));
    await expect(fetchSearchIndex()).rejects.toThrow();
  });
});
