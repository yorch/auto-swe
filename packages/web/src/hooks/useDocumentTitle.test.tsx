// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDocumentTitle, routeDocumentTitle } from '@/lib/documentTitle';
import { useDocumentTitle } from './useDocumentTitle';

function Page({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

/** What Next does on a client navigation: a new `<title>`, inserted ahead of the old one. */
function renderRouteTitle(text: string) {
  const el = document.createElement('title');
  el.textContent = text;
  document.head.insertBefore(el, document.head.querySelector('title'));
}

// MutationObserver callbacks run as microtasks.
const flushObservers = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  cleanup();
  for (const el of document.head.querySelectorAll('title')) {
    el.remove();
  }
});

describe('useDocumentTitle', () => {
  it('outlasts a route title Next renders after the page set its own', async () => {
    renderRouteTitle(formatDocumentTitle('Runs'));
    render(<Page title="Run · Fix login" />);
    expect(document.title).toBe(formatDocumentTitle('Run · Fix login'));

    renderRouteTitle(formatDocumentTitle('Run'));
    await flushObservers();
    expect(document.title).toBe(formatDocumentTitle('Run · Fix login'));
  });

  it('leaves the route title alone while its data is loading', () => {
    renderRouteTitle(formatDocumentTitle('Requests'));
    render(<Page title={null} />);
    expect(document.title).toBe(formatDocumentTitle('Requests'));
  });

  it('puts the current route title back when the page lets go of its own', async () => {
    renderRouteTitle(formatDocumentTitle('Run'));
    const page = render(<Page title="Run a" />);
    page.rerender(<Page title={null} />);
    expect(document.title).toBe(routeDocumentTitle(window.location.pathname));

    // Once released, a later route title is not overwritten.
    renderRouteTitle(formatDocumentTitle('Requests'));
    await flushObservers();
    expect(document.title).toBe(formatDocumentTitle('Requests'));

    page.rerender(<Page title="Run b" />);
    expect(document.title).toBe(formatDocumentTitle('Run b'));
  });
});
