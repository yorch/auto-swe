// Shared scaffolding for React-Testing-Library tests in this package.
// Component tests opt into jsdom via a `// @vitest-environment jsdom` pragma
// at the top of each file — the global vitest env is 'node'.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

/** Wrap a UI tree in a fresh QueryClient with retries off (fail-fast in tests). */
export function withQuery(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

/**
 * jsdom (as of writing) doesn't implement HTMLDialogElement.showModal/close —
 * call this from beforeEach so the Modal primitive's useEffect doesn't crash.
 * Real browsers run the native implementations.
 */
export function stubDialogPrototype(): void {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  }
}

/**
 * Install a fetch spy that dispatches to per-path handlers. Handler keys are
 * either `"<path>"` (matches any method) or `"<METHOD> <path>"` (e.g.
 * `"POST /api/v1/auth/tokens"`); the method-qualified form wins when both are
 * registered for the same path. Each handler returns the JSON body to send
 * back; the helper wraps it in a 200 Response. Returns the spy so the test
 * can inspect call args.
 *
 * Use the method-qualified form whenever a single endpoint is hit with
 * multiple verbs in the same test (e.g. list-GET + create-POST on the same
 * path) — otherwise the page mounting + the user action will both receive
 * the same payload shape and the page-mount path will explode.
 */
export function setupFetchMock(
  handlers: Record<string, (body?: unknown) => unknown>
): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const handler = handlers[`${method} ${path}`] ?? handlers[path];
    if (!handler) {
      throw new Error(`No fetch mock for ${method} ${path}`);
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return new Response(JSON.stringify(handler(body)), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/** Pull the parsed JSON body out of the first call to a given endpoint. */
export function bodyOf(
  spy: ReturnType<typeof vi.fn>,
  pathSuffix: string,
  method = 'POST'
): unknown {
  const call = spy.mock.calls.find(([url, init]) => {
    const u = typeof url === 'string' ? url : url.toString();
    return u.includes(pathSuffix) && (init as RequestInit | undefined)?.method === method;
  });
  if (!call) {
    throw new Error(`expected a ${method} to ${pathSuffix}`);
  }
  return JSON.parse((call[1] as RequestInit).body as string);
}
