// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageRegistryRow } from '@/hooks/usePackageRegistries';

const base: PackageRegistryRow = {
  accessMode: 'lockfile',
  allowPrivateNetwork: false,
  authKind: 'bearer',
  createdAt: '2026-10-20T00:00:00Z',
  ecosystem: 'npm',
  hasToken: true,
  id: 'row-npm',
  isActive: true,
  name: 'npmjs',
  npmScopes: ['@acme'],
  teamId: null,
  tokenLastFour: 'abcd',
  updatedAt: '2026-10-20T00:00:00Z',
  upstreamUrl: 'https://registry.npmjs.org',
};
const rows: PackageRegistryRow[] = [
  base,
  { ...base, ecosystem: 'go', id: 'row-go', name: 'goproxy', npmScopes: [] },
];

const createMutate = vi.fn().mockResolvedValue({});
const updateMutate = vi.fn().mockResolvedValue({});
vi.mock('@/hooks/usePackageRegistries', () => ({
  useCreatePackageRegistry: () => ({ isPending: false, mutateAsync: createMutate }),
  useDeletePackageRegistry: () => ({ isPending: false, mutateAsync: vi.fn() }),
  usePackageRegistries: () => ({
    data: rows,
    error: null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useUpdatePackageRegistry: () => ({ isPending: false, mutateAsync: updateMutate }),
}));

const { PackageRegistriesTab } = await import('./PackageRegistriesTab');

// jsdom implements <dialog> without showModal()/close().
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
});

describe('PackageRegistriesTab', () => {
  it('lists the ecosystem, and "default" scopes for a Go row', () => {
    render(<PackageRegistriesTab />);
    expect(screen.getAllByText('Ecosystem').length).toBeGreaterThan(0);
    expect(screen.getAllByText('npm').length).toBeGreaterThan(0);
    expect(screen.getAllByText('go').length).toBeGreaterThan(0);
    expect(screen.getByText('@acme')).toBeTruthy();
    expect(screen.getAllByText('default').length).toBeGreaterThan(0);
  });

  it('offers the ecosystem select on create only', () => {
    render(<PackageRegistriesTab />);
    fireEvent.click(screen.getByText('Add registry'));
    expect(screen.getByLabelText('Ecosystem')).toBeTruthy();
    expect(screen.getByLabelText('npm scopes')).toBeTruthy();
  });

  it('shows the ecosystem read-only when editing', () => {
    render(<PackageRegistriesTab />);
    fireEvent.click(screen.getAllByText('Edit')[1]);
    expect(screen.queryByLabelText('Ecosystem')).toBeNull();
    expect(screen.getByText('Ecosystem: Go')).toBeTruthy();
    expect(screen.queryByLabelText('npm scopes')).toBeNull();
  });

  it('hides and clears scopes for Go, and sends ecosystem go', async () => {
    render(<PackageRegistriesTab />);
    fireEvent.click(screen.getByText('Add registry'));
    fireEvent.change(screen.getByLabelText('npm scopes'), { target: { value: '@acme' } });
    fireEvent.change(screen.getByLabelText('Ecosystem'), { target: { value: 'go' } });
    expect(screen.queryByLabelText('npm scopes')).toBeNull();
    expect(screen.getByText(/serves every module for its team/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'goproxy' } });
    fireEvent.change(screen.getByLabelText(/^Upstream URL/), {
      target: { value: 'https://proxy.golang.org' },
    });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(createMutate).toHaveBeenCalled());
    expect(createMutate).toHaveBeenCalledWith(
      expect.objectContaining({ ecosystem: 'go', npmScopes: [] })
    );
  });

  it('does not send the ecosystem when updating', async () => {
    render(<PackageRegistriesTab />);
    fireEvent.click(screen.getAllByText('Edit')[0]);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(updateMutate).toHaveBeenCalled());
    expect(updateMutate.mock.calls[0][0]).not.toHaveProperty('ecosystem');
  });
});
