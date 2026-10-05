// @vitest-environment jsdom

// The real query hooks, a real QueryClient with the app's defaults, and only the HTTP
// client mocked: what is under test is that nothing re-reads the diff behind the admin's back.

import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: { get, post },
}));

const { ReviewUpdateModal } = await import('./ReviewUpdateModal');

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const changed = (text: string, revision: number) => ({
  blockedByScan: false,
  description: { changed: false, new: 'd', old: 'd' },
  diffIncomplete: false,
  diffTooLarge: false,
  folder: 'skills/a',
  handEdited: true,
  ignoredKeys: [],
  installedRevision: revision,
  name: 'a',
  referenceFiles: { added: [], changed: [], removed: [] },
  renamedTo: null,
  scanWarnings: [],
  skillId: 'id-a',
  skippedFiles: [],
  textDiff: `@@ -1 +1 @@\n+${text}`,
  textDiffTruncated: false,
  textLength: { new: 5, old: 5 },
});
const diffAt = (sha: string, text: string, revision: number) => ({
  data: {
    added: [],
    changed: [changed(text, revision)],
    errors: [],
    removed: [],
    sha,
    source: { id: 'src-1', latestSha: sha, pinnedSha: 'a'.repeat(40), status: 'UPDATE_AVAILABLE' },
    unchanged: [],
  },
});

function mount() {
  const client = new QueryClient({
    // The app's defaults (Providers.tsx).
    defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ReviewUpdateModal onClose={() => {}} sourceId="src-1" />
    </QueryClientProvider>
  );
  return { client, view };
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValueOnce(diffAt(SHA_B, 'REVIEWED TEXT', 3));
  post.mockResolvedValue({
    data: {
      accepted: [],
      after: { pinnedSha: SHA_B, status: 'OK' },
      conflicts: [],
      notSelected: [],
      pinAdvanced: true,
      sha: SHA_B,
    },
  });
});
afterEach(() => focusManager.setFocused(undefined));

describe('the reviewed diff is frozen', () => {
  it('a window focus does not re-read the diff or change what accept sends', async () => {
    // If anything re-read the diff it would now answer with a different commit and revision.
    get.mockResolvedValue(diffAt(SHA_C, 'NEVER REVIEWED', 4));
    mount();
    await screen.findByText('+REVIEWED TEXT');
    fireEvent.click(screen.getByLabelText(/Overwrite my edit/));
    fireEvent.click(screen.getByLabelText('Update a'));

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByText('+REVIEWED TEXT')).toBeTruthy();
    expect(screen.queryByText('+NEVER REVIEWED')).toBeNull();
    fireEvent.click(screen.getByText('Accept 1 skill'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/v1/platform/skill-sources/src-1/accept', {
        sha: SHA_B,
        skills: [{ name: 'a', revision: 3 }],
      })
    );
  });

  it('Reload diff re-reads it and drops every pick and confirmation', async () => {
    get.mockResolvedValueOnce(diffAt(SHA_C, 'NEW TEXT', 4));
    post.mockRejectedValueOnce(
      Object.assign(new Error('It moved.'), { code: 'SKILL_CHANGED', status: 409 })
    );
    const { ApiError } = await import('@/lib/api');
    post.mockReset();
    post.mockRejectedValueOnce(new ApiError('It moved.', 409, 'SKILL_CHANGED'));
    mount();
    await screen.findByText('+REVIEWED TEXT');
    fireEvent.click(screen.getByLabelText(/Overwrite my edit/));
    fireEvent.click(screen.getByLabelText('Update a'));
    fireEvent.click(screen.getByText('Accept 1 skill'));
    fireEvent.click(await screen.findByText('Reload diff'));
    await screen.findByText('+NEW TEXT');
    expect(get).toHaveBeenCalledTimes(2);
    // The overwrite confirmation about revision 3 does not carry over to revision 4.
    expect((screen.getByLabelText(/Overwrite my edit/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Update a') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Accept 0 skills')).toBeTruthy();
  });

  it('a mutation elsewhere (the sources list invalidating its prefix) does not re-read the diff', async () => {
    get.mockResolvedValue(diffAt(SHA_C, 'NEVER REVIEWED', 4));
    const { client } = mount();
    await screen.findByText('+REVIEWED TEXT');
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['skill-sources'] });
      await client.invalidateQueries({ queryKey: ['skills'] });
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
