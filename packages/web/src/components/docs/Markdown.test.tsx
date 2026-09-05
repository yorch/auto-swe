// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

const SERVED = new Set(['agents', 'architecture', 'README']);

describe('Markdown on the docs surface', () => {
  it('rewrites a cross-doc link to its page', () => {
    render(<Markdown servedSlugs={SERVED}>{'See [agents](./agents.md).'}</Markdown>);
    expect(screen.getByRole('link', { name: 'agents' }).getAttribute('href')).toBe('/docs/agents');
  });

  it('keeps the anchor when rewriting', () => {
    render(<Markdown servedSlugs={SERVED}>{'[gaps](./agents.md#11-limitations)'}</Markdown>);
    expect(screen.getByRole('link', { name: 'gaps' }).getAttribute('href')).toBe(
      '/docs/agents#11-limitations'
    );
  });

  it('renders an unservable link as text, not a dead link', () => {
    // ../AGENTS.md would resolve to /AGENTS.md — a 404 at the app root.
    render(<Markdown servedSlugs={SERVED}>{'See [AGENTS.md](../AGENTS.md).'}</Markdown>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('AGENTS.md')).toBeTruthy();
  });

  it('renders a frozen history link as text', () => {
    render(<Markdown servedSlugs={SERVED}>{'[RFC](./history/evals-rfc.md)'}</Markdown>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('RFC')).toBeTruthy();
  });

  it('opens external links in a new tab', () => {
    render(<Markdown servedSlugs={SERVED}>{'[Slack](https://api.slack.com/apps)'}</Markdown>);
    const link = screen.getByRole('link', { name: 'Slack' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves in-app routes alone and in the same tab', () => {
    render(<Markdown servedSlugs={SERVED}>{'[config](/studio/models)'}</Markdown>);
    const link = screen.getByRole('link', { name: 'config' });
    expect(link.getAttribute('href')).toBe('/studio/models');
    expect(link.getAttribute('target')).toBeNull();
  });

  it('labels a mermaid block as diagram source', () => {
    render(<Markdown servedSlugs={SERVED}>{'```mermaid\nflowchart LR\n  A --> B\n```'}</Markdown>);
    expect(screen.getByText(/Mermaid diagram source/)).toBeTruthy();
  });

  it('leaves other fenced blocks unlabelled', () => {
    render(<Markdown servedSlugs={SERVED}>{'```bash\nyarn build\n```'}</Markdown>);
    expect(screen.queryByText(/Mermaid diagram source/)).toBeNull();
    expect(screen.getByText(/yarn build/)).toBeTruthy();
  });

  it('does not leak react-markdown internals into the DOM', () => {
    // Spreading the component's rest props stamps node="[object Object]" onto
    // every anchor and code element — 462 of them on the architecture page.
    const { container } = render(
      <Markdown servedSlugs={SERVED}>
        {'[a](./agents.md) and `x`\n\n```mermaid\nflowchart LR\n```'}
      </Markdown>
    );
    expect(container.querySelectorAll('[node]')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('[object Object]');
  });

  it('leaves links untouched when no served set is supplied', () => {
    // Other callers render Markdown that is not part of the docs surface.
    render(<Markdown>{'See [agents](./agents.md).'}</Markdown>);
    expect(screen.getByRole('link', { name: 'agents' }).getAttribute('href')).toBe('./agents.md');
  });
});
