// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detail } from '@/test/orchestrationFixtures';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const calls = vi.hoisted(() => ({ cancel: vi.fn(async () => undefined), end: vi.fn() }));
const idle = { error: null, isError: false, isPending: false, reset: vi.fn() };
vi.mock('@/hooks/useOrchestrations', () => ({
  useCancelOrchestration: () => ({ ...idle, mutateAsync: calls.cancel }),
  useEndOrchestration: () => ({ ...idle, mutateAsync: calls.end }),
}));

import { OrchestrationHeader } from './OrchestrationHeader';

beforeEach(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('OrchestrationHeader stop controls', () => {
  it('gives the launcher End and Cancel, and no emergency stop', () => {
    render(<OrchestrationHeader detail={detail({ canControl: true, canEmergencyStop: false })} />);
    expect(screen.getByRole('button', { name: 'End' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Emergency stop/ })).toBeNull();
    expect(screen.queryByText(/can end this orchestration/)).toBeNull();
  });

  it('offers a labelled emergency stop to a platform admin, behind a confirm', async () => {
    render(
      <OrchestrationHeader
        detail={detail({ canControl: false, canEmergencyStop: true, launchedByName: null })}
      />
    );
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();
    expect(screen.queryByText(/can end this orchestration/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Emergency stop (platform admin)' }));
    expect(calls.cancel).not.toHaveBeenCalled();
    expect(screen.getByText(/as a platform admin/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Emergency stop' }));
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledTimes(1));
  });

  it('names the launcher for someone who cannot stop it', () => {
    render(
      <OrchestrationHeader
        detail={detail({ canControl: false, canEmergencyStop: false, launchedByName: 'Ada' })}
      />
    );
    expect(screen.getByText('Only Ada can end this orchestration.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Emergency stop/ })).toBeNull();
  });

  it('says "the launcher" when the launcher has no name, and stays quiet once it has ended', () => {
    const { rerender } = render(
      <OrchestrationHeader detail={detail({ canControl: false, launchedByName: null })} />
    );
    expect(screen.getByText('Only the launcher can end this orchestration.')).toBeTruthy();
    rerender(
      <OrchestrationHeader
        detail={detail({ canControl: false, launchedByName: null, status: 'COMPLETED' })}
      />
    );
    expect(screen.queryByText(/can end this orchestration/)).toBeNull();
  });
});
