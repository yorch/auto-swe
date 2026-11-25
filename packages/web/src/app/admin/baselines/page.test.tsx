// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const { state } = vi.hoisted(() => ({
  state: {
    manage: new Set<string>(),
    orgs: [] as { id: string; name: string }[],
    platformAdmin: false,
  },
}));

vi.mock('@/hooks/useCan', () => ({
  useOrgIdsCan: () => state.manage,
  usePlatformAdmin: () => state.platformAdmin,
}));
vi.mock('@/hooks/useAdmin', () => {
  const idle = { isError: false, isFetching: false, isLoading: false, refetch: vi.fn() };
  return {
    useCreateHumanErrorBaseline: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useDeleteHumanErrorBaseline: () => ({ mutateAsync: vi.fn() }),
    useHumanErrorBaselines: () => ({
      ...idle,
      data: [
        {
          domain: 'code',
          errorCount: 3,
          errorRate: 0.1,
          id: 'b1',
          outcomeType: null,
          recordedAt: '2026-01-01T00:00:00.000Z',
          sampleSize: 30,
        },
      ],
    }),
    useOrganizationDirectory: () => ({ ...idle, data: state.orgs }),
  };
});

const { default: Page } = await import('./page');

beforeEach(() => {
  stubDialogPrototype();
  state.manage = new Set();
  state.orgs = [{ id: 'o1', name: 'Acme' }];
  state.platformAdmin = false;
});
afterEach(cleanup);

describe('baselines page', () => {
  it('hides recording and deleting from a member who is not an organization admin', () => {
    render(<Page />);
    expect(screen.queryByRole('button', { name: /New baseline/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('offers recording and deleting where the server grants org.baselines.manage', () => {
    state.manage = new Set(['o1']);
    render(<Page />);
    expect(screen.getByRole('button', { name: /New baseline/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Delete/ })).toBeTruthy();
  });

  it('lets a platform admin who belongs to no organization pick one from the directory', () => {
    state.platformAdmin = true;
    render(<Page />);
    expect(screen.getByRole('button', { name: /New baseline/ })).toBeTruthy();
  });
});
