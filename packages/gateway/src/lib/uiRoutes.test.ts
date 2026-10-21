import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_ROUTE_TEMPLATES, uiRouteTemplate } from './uiRoutes.js';

const APP_DIR = join(import.meta.dirname, '../../../web/src/app');

/** Every `page.tsx` under the app directory, as a Next route template. */
function pageTemplates(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // A route group `(x)` adds no URL segment.
      const segment = name.startsWith('(') && name.endsWith(')') ? '' : `/${name}`;
      found.push(...pageTemplates(full, prefix + segment));
    } else if (name === 'page.tsx') {
      found.push(prefix === '' ? '/' : prefix);
    }
  }
  return found;
}

describe('UI route allowlist', () => {
  it('matches the dashboard page tree exactly', () => {
    const pages = pageTemplates(APP_DIR).sort();
    expect(
      [...UI_ROUTE_TEMPLATES].sort(),
      'update lib/uiRoutes.ts to follow the page tree'
    ).toEqual(pages);
  });

  it('normalizes a concrete path to its template', () => {
    expect(uiRouteTemplate('/runs/5d2c0f1e-aaaa-bbbb-cccc-1234567890ab')).toBe('/runs/[id]');
    expect(uiRouteTemplate('/runs')).toBe('/runs');
    expect(uiRouteTemplate('/runs/')).toBe('/runs');
    expect(uiRouteTemplate('/')).toBe('/');
    expect(uiRouteTemplate('/library/abc/diff')).toBe('/library/[id]/diff');
    expect(uiRouteTemplate('/admin/users')).toBe('/admin/users');
    expect(uiRouteTemplate('/runs/[id]')).toBe('/runs/[id]');
  });

  it('refuses anything that is not a bare page path', () => {
    for (const bad of [
      '',
      'runs',
      '/runs?token=abc',
      '/runs#frag',
      '/runs/../admin',
      '/nope',
      '/runs/a/b',
      '/runs/\u0000',
      `/${'a'.repeat(300)}`,
    ]) {
      expect(uiRouteTemplate(bad), bad).toBeNull();
    }
  });
});
