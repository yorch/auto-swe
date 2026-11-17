// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('@/hooks/useHarnessProfiles', () => ({
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
});

describe('HooksSwitch', () => {
  it('asks before turning hooks on, stating the authority and that scripts remain', async () => {
    render(<HooksSwitch enabled={false} name="review-kit" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Hooks for review-kit' }));
    expect(patch).not.toHaveBeenCalled();
    expect(
      screen.getByText(/run commands in the run container with the agent’s authority/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Scripts and executable files in the plugin are still written/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn hooks on' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ hooksEnabled: true, name: 'review-kit' })
    );
  });

  it('turns hooks off the same way', async () => {
    render(<HooksSwitch enabled name="review-kit" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Hooks for review-kit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn hooks off' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith({ hooksEnabled: false, name: 'review-kit' })
    );
  });

  it('shows a failure and changes nothing else', async () => {
    patch.mockRejectedValue(new Error('Forbidden'));
    render(<HooksSwitch enabled={false} name="review-kit" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Hooks for review-kit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn hooks on' }));
    expect(await screen.findByText('Forbidden')).toBeTruthy();
  });
});
