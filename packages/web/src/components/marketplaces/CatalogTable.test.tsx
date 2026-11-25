// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogEntryDto } from '@/hooks/useMarketplaces';
import { CatalogTable } from './CatalogTable';

const entry = (over: Partial<CatalogEntryDto>): CatalogEntryDto => ({
  description: 'does things',
  ignoredKeys: [],
  installable: true,
  name: 'kit',
  nameTaken: false,
  profile: null,
  reason: null,
  source: { kind: 'relative', path: 'plugins/kit' },
  strict: false,
  version: '1.0.0',
  ...over,
});

const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

describe('CatalogTable', () => {
  it('shows installable, the reason when not, the existing profile and a taken name', () => {
    render(
      <CatalogTable
        entries={[
          entry({}),
          entry({
            installable: false,
            name: 'npm-kit',
            reason: 'Only GitHub and relative sources are supported',
            source: { kind: 'unsupported', type: 'npm' },
          }),
          entry({ name: 'have', profile: { latestVersion: 3, name: 'have', status: 'OK' } }),
          entry({ name: 'clash', nameTaken: true }),
        ]}
      />
    );
    expect(within(rowOf('kit')).getByText('Installable')).toBeTruthy();
    const npm = rowOf('npm-kit');
    expect(within(npm).getByText('Not installable')).toBeTruthy();
    expect(within(npm).getByText('Only GitHub and relative sources are supported')).toBeTruthy();
    expect(within(rowOf('have')).getByText('Approved as have v3')).toBeTruthy();
    expect(within(rowOf('clash')).getByText('Name taken')).toBeTruthy();
  });

  it('offers Approve only for an installable, free, not-yet-approved entry', () => {
    const onApprove = vi.fn();
    render(
      <CatalogTable
        entries={[
          entry({}),
          entry({ installable: false, name: 'no' }),
          entry({ name: 'have', profile: { latestVersion: 1, name: 'have', status: 'OK' } }),
          entry({ name: 'clash', nameTaken: true }),
        ]}
        onApprove={onApprove}
      />
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Approve kit' }));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ name: 'kit' }));
  });

  it('makes repository text visible and labels a nameless entry', () => {
    render(
      <CatalogTable
        entries={[
          entry({ description: 'bad‮ text', installable: false, name: null, reason: 'no name' }),
        ]}
      />
    );
    expect(screen.getByText('(no valid name)')).toBeTruthy();
    expect(screen.getByText('bad⟨U+202E⟩ text')).toBeTruthy();
  });

  it('says an empty catalog is empty', () => {
    render(<CatalogTable entries={[]} />);
    expect(screen.getByText(/lists no plugins/)).toBeTruthy();
  });
});
