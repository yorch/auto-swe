// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { EgressAllowlistEditor } from './EgressAllowlistEditor';

afterEach(() => vi.unstubAllGlobals());

describe('EgressAllowlistEditor', () => {
  it('shows an empty read-only baseline without adding entries to the team list', async () => {
    setupFetchMock({
      'GET /api/v1/teams/t1/egress-allowlist': () => ({
        data: { baselineAllowlist: [], egressAllowlist: [] },
      }),
    });
    render(withQuery(<EgressAllowlistEditor teamId="t1" />));
    expect(await screen.findByText('No platform baseline hosts configured.')).toBeTruthy();
    expect((screen.getByPlaceholderText('registry.npmjs.org') as HTMLTextAreaElement).value).toBe(
      ''
    );
  });
  it('does not present a failed baseline load as an empty platform list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
          })
      )
    );
    render(withQuery(<EgressAllowlistEditor teamId="t1" />));
    expect(await screen.findByText('Unable to load platform baseline.')).toBeTruthy();
  });
  it('loads current allowlist into the textarea and PUTs the parsed list on save', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/teams/t1/egress-allowlist': () => ({
        data: { baselineAllowlist: ['pypi.org'], egressAllowlist: ['registry.npmjs.org'] },
      }),
      'PUT /api/v1/teams/t1/egress-allowlist': (body) => ({
        data: {
          egressAllowlist: (body as { egressAllowlist: string[] }).egressAllowlist,
        },
        warnings: ['restricted requires an egress proxy'],
      }),
    });

    render(withQuery(<EgressAllowlistEditor teamId="t1" />));

    const textarea = await waitFor(() => {
      const ta = screen.getByPlaceholderText(/registry\.npmjs\.org/) as HTMLTextAreaElement;
      expect(ta.value).toBe('registry.npmjs.org');
      return ta;
    });
    expect(screen.getByRole('region', { name: 'platform baseline, always included' })).toBeTruthy();
    expect(screen.getByText('pypi.org')).toBeTruthy();
    expect(textarea.value).not.toContain('pypi.org');

    // Edit: add a second entry, mix in blank lines that should be stripped
    fireEvent.change(textarea, {
      target: { value: 'registry.npmjs.org\n\n  api.github.com  \n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save allowlist/i }));

    await waitFor(() => {
      expect(screen.getByText(/saved/i)).toBeTruthy();
    });
    expect(screen.getByText('restricted requires an egress proxy')).toBeTruthy();

    const putCall = spy.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT'
    );
    if (!putCall) {
      throw new Error('expected a PUT');
    }
    const body = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      egressAllowlist: ['registry.npmjs.org', 'api.github.com'],
    });
  });
});
