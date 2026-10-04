// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { parseRepository, SkillImportModal } from './SkillImportModal';

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

const skill = (over: Record<string, unknown>) => ({
  blockedByScan: false,
  conflicts: [],
  description: 'Write the test first',
  errors: [],
  folder: 'tdd',
  installable: true,
  name: 'tdd',
  referenceFileCount: 0,
  scanWarnings: [],
  skippedFiles: [],
  textLength: 1200,
  ...over,
});

describe('parseRepository', () => {
  it('reads owner/name and github URLs', () => {
    expect(parseRepository('acme/skills')).toEqual({ owner: 'acme', repo: 'skills' });
    expect(parseRepository('https://github.com/acme/skills.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'skills',
    });
    expect(parseRepository('not a repo')).toBeNull();
  });
});

describe('SkillImportModal', () => {
  it('previews the repository, lets the admin choose skills, and imports at the previewed commit', async () => {
    const spy = setupFetchMock({
      'POST /api/v1/platform/skill-sources': () => ({ data: { skills: [] } }),
      'POST /api/v1/platform/skill-sources/preview': () => ({
        data: {
          sha: 'a'.repeat(40),
          skills: [
            skill({}),
            skill({
              conflicts: [{ id: 'x', name: 'review', scope: 'GLOBAL' }],
              folder: 'review',
              installable: false,
              name: 'review',
            }),
          ],
        },
      }),
    });
    const onImported = vi.fn();
    render(withQuery(<SkillImportModal onClose={() => {}} onImported={onImported} />));
    fireEvent.change(screen.getByLabelText(/^Repository/), { target: { value: 'acme/skills' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText(/A skill named "review" already exists/)).toBeTruthy();
    // The conflicting skill cannot be chosen; the clean one is chosen already.
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, true],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 skill' }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const create = spy.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/skill-sources') && (init as RequestInit).method === 'POST'
    );
    expect(create).toBeDefined();
    expect(JSON.parse(((create as unknown[])[1] as RequestInit).body as string)).toMatchObject({
      owner: 'acme',
      ref: 'main',
      repo: 'skills',
      sha: 'a'.repeat(40),
      skills: ['tdd'],
    });
  });
});
