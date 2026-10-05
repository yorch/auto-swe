// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundlePreview } from '@/hooks/useBundles';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { BundlePreviewModal } from './BundlePreviewModal';

const preview = (over: Partial<BundlePreview> = {}): BundlePreview => ({
  blockedReason: null,
  contentHash: 'h',
  entities: {
    agents: [{ action: 'replace', name: 'reviewer', protected: true }],
    scannerPatterns: [],
    skills: [{ action: 'create', name: 'tdd', protected: false }],
    templates: [],
  },
  installedVersion: null,
  name: 'swe',
  signedBy: null,
  source: null,
  trustState: 'VERIFIED',
  version: '2',
  warnings: [],
  ...over,
});

const result = {
  counts: { agents: 1, scannerPatterns: 0, skills: 1, templates: 0 },
  trustState: 'VERIFIED' as const,
  warnings: [],
};

beforeEach(() => stubDialogPrototype());

describe('BundlePreviewModal', () => {
  it('lists what is created and replaced, and gates built-in replacement behind a checkbox', async () => {
    const onInstall = vi.fn(async () => result);
    render(<BundlePreviewModal onClose={() => {}} onInstall={onInstall} preview={preview()} />);
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.getByText('tdd')).toBeTruthy();
    const install = screen.getByRole('button', { name: 'Install bundle' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Replace 1 built-in/));
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    await waitFor(() => expect(onInstall).toHaveBeenCalledWith(true));
  });

  it('asks a second time before installing an unverified bundle', async () => {
    const onInstall = vi.fn(async () => result);
    render(
      <BundlePreviewModal
        onClose={() => {}}
        onInstall={onInstall}
        preview={preview({
          entities: { agents: [], scannerPatterns: [], skills: [], templates: [] },
          trustState: 'UNVERIFIED',
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Install unverified bundle…' }));
    expect(onInstall).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Install unverified bundle' }));
    await waitFor(() => expect(onInstall).toHaveBeenCalledWith(false));
  });

  it('cannot be installed when the deployment refuses unverified bundles', () => {
    render(
      <BundlePreviewModal
        onClose={() => {}}
        onInstall={vi.fn(async () => result)}
        preview={preview({
          blockedReason: 'This bundle is unverified and this deployment does not allow it.',
          trustState: 'UNVERIFIED',
        })}
      />
    );
    expect(screen.getByText(/does not allow it/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Install unverified bundle…/ }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });
});
