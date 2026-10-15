import { describe, expect, it } from 'vitest';
import { formatDocumentTitle, routeDocumentTitle } from './documentTitle';
import { knownPageTitle } from './navigation';

describe('routeDocumentTitle', () => {
  it("names the route's page ahead of the site", () => {
    const title = knownPageTitle('/runs');
    expect(title).toBeTruthy();
    expect(routeDocumentTitle('/runs')).toBe(`${title} · auto·swe`);
  });

  it('is the bare site name for a path no page claims, or no path at all', () => {
    expect(routeDocumentTitle('/no-such-page-anywhere')).toBe('auto·swe');
    expect(routeDocumentTitle(null)).toBe('auto·swe');
  });

  it('formats a missing title as the bare site name', () => {
    expect(formatDocumentTitle('')).toBe('auto·swe');
    expect(formatDocumentTitle('Docs')).toBe('Docs · auto·swe');
  });
});
