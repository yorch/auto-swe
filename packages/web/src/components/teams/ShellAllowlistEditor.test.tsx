// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { ShellAllowlistEditor } from './ShellAllowlistEditor';

afterEach(() => vi.unstubAllGlobals());

describe('ShellAllowlistEditor', () => {
  it('loads current allowlist into the textarea and PUTs the parsed list on save', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/teams/t1/shell-image-allowlist': () => ({
        data: { shellImageAllowlist: ['ghcr.io/acme/old:1'] },
      }),
      'PUT /api/v1/teams/t1/shell-image-allowlist': (body) => ({
        data: {
          shellImageAllowlist: (body as { shellImageAllowlist: string[] }).shellImageAllowlist,
        },
      }),
    });

    render(withQuery(<ShellAllowlistEditor teamId="t1" />));

    const textarea = await waitFor(() => {
      const ta = screen.getByPlaceholderText(/ghcr.io\/acme/) as HTMLTextAreaElement;
      // The GET response should have populated the textarea
      expect(ta.value).toBe('ghcr.io/acme/old:1');
      return ta;
    });

    // Edit: replace with two entries (mixed whitespace + blank lines that should be trimmed out)
    fireEvent.change(textarea, {
      target: { value: 'ghcr.io/acme/new:1\n\n  docker.io/library/python:3.13-slim  \n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save allowlist/i }));

    await waitFor(() => {
      expect(screen.getByText(/✓ saved/i)).toBeTruthy();
    });

    // Pull the PUT body — the editor should have trimmed each line + dropped blanks
    const putCall = spy.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT'
    );
    if (!putCall) throw new Error('expected a PUT');
    const body = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(body).toEqual({
      shellImageAllowlist: ['ghcr.io/acme/new:1', 'docker.io/library/python:3.13-slim'],
    });
  });
});
