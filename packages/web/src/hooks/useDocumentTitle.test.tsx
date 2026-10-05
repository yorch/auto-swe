// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDocumentTitle, useDocumentTitle, useRouteDocumentTitle } from './useDocumentTitle';

function Shell({ route }: { route: string }) {
  useRouteDocumentTitle(route);
  return null;
}
function Page({ title }: { title: string | null }) {
  useDocumentTitle(title);
  return null;
}

afterEach(cleanup);

describe('document title', () => {
  it('puts the route title back when a page unmounts its own title', () => {
    render(<Shell route="Requests" />);
    const page = render(<Page title="Request · Fix login" />);
    expect(document.title).toBe(formatDocumentTitle('Request · Fix login'));
    page.unmount();
    expect(document.title).toBe(formatDocumentTitle('Requests'));
  });

  it('falls back to the route title while the next page is still loading', () => {
    render(<Shell route="Run" />);
    const page = render(<Page title="Run a" />);
    page.rerender(<Page title={null} />);
    expect(document.title).toBe(formatDocumentTitle('Run'));
    page.rerender(<Page title="Run b" />);
    expect(document.title).toBe(formatDocumentTitle('Run b'));
  });
});
