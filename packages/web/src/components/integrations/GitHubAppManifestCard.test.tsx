// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav, resetNavigation } from '@/test/mockNavigation';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { GitHubAppManifestCard } from './GitHubAppManifestCard';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => resetNavigation());

describe('GitHubAppManifestCard', () => {
  it('asks the gateway for the manifest and posts it to GitHub as a form', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/integrations/github-app-manifest': () => ({
        data: {
          action: 'https://github.com/organizations/acme/settings/apps/new?state=s1',
          manifest: { name: 'auto-swe' },
        },
      }),
    });
    const submit = vi
      .spyOn(HTMLFormElement.prototype, 'submit')
      .mockImplementation(function (this: HTMLFormElement) {});
    render(withQuery(<GitHubAppManifestCard appConfigured={false} installationId={null} />));
    fireEvent.change(screen.getByLabelText(/organization/i), { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub App' }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(bodyOf(spy, '/github-app-manifest')).toEqual({ org: 'acme' });
    const form = submit.mock.contexts[0] as HTMLFormElement;
    expect(form.method).toBe('post');
    expect(form.action).toBe('https://github.com/organizations/acme/settings/apps/new?state=s1');
    const field = form.querySelector('input[name="manifest"]') as HTMLInputElement;
    expect(JSON.parse(field.value)).toEqual({ name: 'auto-swe' });
  });

  it('is hidden once an App is configured, but still offers a reported installation', async () => {
    const { container, rerender } = render(
      withQuery(<GitHubAppManifestCard appConfigured installationId={null} />)
    );
    expect(container.textContent).toBe('');

    nav.search = 'installation_id=987&setup_action=install';
    rerender(withQuery(<GitHubAppManifestCard appConfigured installationId={null} />));
    expect(await screen.findByText('GitHub App installed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save installation ID' })).toBeTruthy();
  });

  it('explains a callback error by its fixed code', () => {
    nav.search = 'github_app_error=CODE_REJECTED';
    render(withQuery(<GitHubAppManifestCard appConfigured={false} installationId={null} />));
    expect(screen.getByText(/GitHub refused the code/)).toBeTruthy();
  });

  it('ignores an installation id that is not numeric', () => {
    nav.search = 'installation_id=1;drop';
    const { container } = render(
      withQuery(<GitHubAppManifestCard appConfigured installationId={null} />)
    );
    expect(container.textContent).toBe('');
  });
});
