// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { EgressAllowlistEditor } from './EgressAllowlistEditor';

afterEach(() => vi.unstubAllGlobals());

describe('EgressAllowlistEditor', () => {
  it('loads current allowlist into the textarea and PUTs the parsed list on save', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/teams/t1/egress-allowlist': () => ({
        data: { egressAllowlist: ['registry.npmjs.org'] },
      }),
      'PUT /api/v1/teams/t1/egress-allowlist': (body) => ({
        data: {
          egressAllowlist: (body as { egressAllowlist: string[] }).egressAllowlist,
        },
      }),
    });

    render(withQuery(<EgressAllowlistEditor teamId="t1" />));

    const textarea = await waitFor(() => {
      const ta = screen.getByPlaceholderText(/registry\.npmjs\.org/) as HTMLTextAreaElement;
      expect(ta.value).toBe('registry.npmjs.org');
      return ta;
    });

    // Edit: add a second entry, mix in blank lines that should be stripped
    fireEvent.change(textarea, {
      target: { value: 'registry.npmjs.org\n\n  api.github.com  \n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save allowlist/i }));

    await waitFor(() => {
      expect(screen.getByText(/✓ saved/i)).toBeTruthy();
    });

    const putCall = spy.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT'
    );
    if (!putCall) throw new Error('expected a PUT');
    const body = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      egressAllowlist: ['registry.npmjs.org', 'api.github.com'],
    });
  });
});
