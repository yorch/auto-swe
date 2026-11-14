// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessProfilePreview } from '@/hooks/useHarnessProfiles';
import { ApiError } from '@/lib/api';

const SHA = 'c'.repeat(40);
const CONTENT = 'd'.repeat(64);
const WARNED = 'e'.repeat(64);

const { create, previewFn, readFn } = vi.hoisted(() => ({
  create: vi.fn(),
  previewFn: vi.fn(),
  readFn: vi.fn(),
}));
vi.mock('@/hooks/useHarnessProfiles', () => ({
  useCreateProfile: () => ({ isPending: false, mutateAsync: create }),
  usePreviewProfile: () => ({ isPending: false, mutateAsync: previewFn }),
  useReviewProfileFile: () => ({ isPending: false, mutateAsync: readFn }),
}));

const { AddProfileModal } = await import('./AddProfileModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const preview = (over: Partial<HarnessProfilePreview> = {}): HarnessProfilePreview => ({
  conflicts: [],
  contentHash: CONTENT,
  files: [
    { mode: '100644', path: 'profile.json', size: 80 },
    { mode: '100755', path: 'plugins/a/run.sh', size: 20 },
  ],
  manifest: { description: 'Review kit', name: 'review-kit', plugins: ['plugins/a'] },
  matchesVersion: null,
  sha: SHA,
  source: { host: 'github.com', owner: 'acme', path: 'kit', ref: 'main', repo: 'pack' },
  totalBytes: 100,
  warnings: [],
  warningsHash: WARNED,
  ...over,
});

async function openAndPreview() {
  render(<AddProfileModal onClose={() => {}} open />);
  fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'acme' } });
  fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'pack' } });
  fireEvent.change(screen.getByLabelText(/^Path/), { target: { value: 'kit' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('Review profile');
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
});

describe('AddProfileModal', () => {
  it('previews, then creates with the previewed sha and both hashes', async () => {
    previewFn.mockResolvedValue(preview());
    await openAndPreview();
    expect(previewFn).toHaveBeenCalledWith({
      host: 'github.com',
      owner: 'acme',
      path: 'kit',
      ref: 'main',
      repo: 'pack',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve profile' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        acknowledgeWarnings: false,
        contentHash: CONTENT,
        host: 'github.com',
        owner: 'acme',
        path: 'kit',
        ref: 'main',
        repo: 'pack',
        sha: SHA,
        warningsHash: WARNED,
      })
    );
  });

  it('will not approve warnings until they are acknowledged, and then says so', async () => {
    previewFn.mockResolvedValue(preview({ warnings: ['hooks are present'] }));
    await openAndPreview();
    const approve = screen.getByRole('button', { name: 'Approve profile' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeWarnings: true }))
    );
  });

  it('refuses a name that is taken', async () => {
    previewFn.mockResolvedValue(preview({ conflicts: [{ name: 'Review-Kit', status: 'OK' }] }));
    await openAndPreview();
    expect(screen.getByText(/already exists/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Approve profile' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('shows repository text with hidden characters made visible', async () => {
    previewFn.mockResolvedValue(
      preview({
        manifest: { description: 'd', name: 'ev‮il' },
        warnings: ['bad‮ thing'],
      })
    );
    await openAndPreview();
    expect(screen.getByText('ev⟨U+202E⟩il')).toBeTruthy();
    expect(screen.getByText('bad⟨U+202E⟩ thing')).toBeTruthy();
  });

  it('reads one file at the previewed commit', async () => {
    previewFn.mockResolvedValue(preview());
    readFn.mockResolvedValue({
      binary: false,
      mode: '100755',
      path: 'plugins/a/run.sh',
      size: 20,
      text: 'echo hi​',
      truncated: false,
    });
    await openAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Read plugins/a/run.sh' }));
    expect(await screen.findByText('echo hi⟨U+200B⟩')).toBeTruthy();
    expect(readFn).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'plugins/a/run.sh', sha: SHA })
    );
  });

  it('offers a fresh preview when the approval is stale', async () => {
    previewFn.mockResolvedValue(preview());
    create.mockRejectedValue(
      new ApiError('The content or the warnings differ', 409, 'PREVIEW_STALE')
    );
    await openAndPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Approve profile' }));
    expect(
      await screen.findByText(/differ from the preview|The content or the warnings/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview again' }));
    await waitFor(() => expect(previewFn).toHaveBeenCalledTimes(2));
  });

  it('lists the reasons for an invalid folder', async () => {
    previewFn.mockRejectedValue(
      new ApiError('The folder is not a valid harness profile', 422, 'HARNESS_PROFILE_INVALID', {
        errors: ['profile.json: unknown key "x"'],
      })
    );
    render(<AddProfileModal onClose={() => {}} open />);
    fireEvent.change(screen.getByLabelText(/^Owner/), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'pack' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('profile.json: unknown key "x"')).toBeTruthy();
  });
});
