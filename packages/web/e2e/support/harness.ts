import { expect, type Page, type Route } from '@playwright/test';
import { NOW } from '../fixtures/common';
import { findRoute } from '../fixtures/routes';
import { ACCESS_TOKEN, BETTER_AUTH_SESSION, VIEWER } from '../fixtures/session';

/** One of the four looks: a palette (navy is the default) in a theme. */
export interface Look {
  palette: 'navy' | 'graphite';
  theme: 'light' | 'dark';
}

export const LOOKS: Look[] = [
  { palette: 'navy', theme: 'dark' },
  { palette: 'navy', theme: 'light' },
  { palette: 'graphite', theme: 'dark' },
  { palette: 'graphite', theme: 'light' },
];

export const lookName = (look: Look) => `${look.palette}-${look.theme}`;

/** One-time callouts the shots should not be about; dismissed as the viewer would. */
const DISMISSED = ['governance-guide', 'first-run-checklist', 'product-tour'];

/** Freezes motion and the text caret, so nothing mid-transition is captured. */
const STILL_CSS = `*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
  caret-color: transparent !important; scroll-behavior: auto !important;
}`;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });

/**
 * Signs the viewer in, seeds the look and the frozen clock, and answers every
 * gateway call from the fixtures. Returns the calls no fixture answered; a
 * shot asserts that list is empty, so a page that starts fetching something
 * new fails loudly here instead of rendering an error state into a baseline.
 */
export async function prepare(page: Page, baseURL: string, look: Look): Promise<string[]> {
  const { hostname } = new URL(baseURL);
  await page.context().addCookies([
    { domain: hostname, name: 'web-session-active', path: '/', value: '1' },
    { domain: hostname, name: 'accessToken', path: '/', value: ACCESS_TOKEN },
  ]);
  await page.addInitScript(
    ({ dismissed, palette, theme, userId }) => {
      localStorage.setItem('auto-swe.theme', theme);
      localStorage.setItem('auto-swe.palette', palette);
      for (const key of dismissed) {
        localStorage.setItem(`auto-swe.dismissed.${userId}.${key}`, '1');
      }
    },
    { dismissed: DISMISSED, palette: look.palette, theme: look.theme, userId: VIEWER.id }
  );
  await page.clock.setFixedTime(NOW);

  const unhandled: string[] = [];
  await page.route(/\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/get-session') {
      return json(route, BETTER_AUTH_SESSION);
    }
    if (url.pathname === '/api/v1/auth/session-token') {
      return json(route, { data: { accessToken: ACCESS_TOKEN } });
    }
    if (url.pathname === '/api/v1/human-steps/stream') {
      // 204 ends an EventSource for good, so it never reconnects mid-shot.
      return route.fulfill({ status: 204 });
    }
    const found = findRoute(request.method(), url);
    if (found) {
      return json(route, found.route.respond(url, found.match));
    }
    unhandled.push(`${request.method()} ${url.pathname}${url.search}`);
    return json(route, { error: { code: 'NO_FIXTURE', message: 'No fixture' } }, 404);
  });
  return unhandled;
}

/** Waits until the page has settled: fonts loaded, nothing loading, no motion pending. */
export async function settle(page: Page) {
  await page.addStyleTag({ content: STILL_CSS });
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  // Two frames: React commits, then the browser paints what it committed.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
