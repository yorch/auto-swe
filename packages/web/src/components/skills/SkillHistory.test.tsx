// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '@/hooks/useSkills';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { SkillHistory } from './SkillHistory';

const SKILL = { currentRevision: 2, id: 's1', isBuiltIn: false } as Skill;

function revisions() {
  return {
    data: [
      {
        createdAt: '2026-02-01T00:00:00Z',
        createdByEmail: 'ada@example.com',
        description: null,
        id: 'r2',
        isCurrent: true,
        promptText: 'Be brief.\nUse tests.',
        revision: 2,
      },
      {
        createdAt: '2026-01-01T00:00:00Z',
        createdByEmail: null,
        description: null,
        id: 'r1',
        isCurrent: false,
        promptText: 'Be brief.',
        revision: 1,
      },
    ],
  };
}

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('SkillHistory', () => {
  it('shows the prompt change between a revision and the one before it', async () => {
    setupFetchMock({ 'GET /api/v1/platform/skills/s1/revisions': revisions });
    render(withQuery(<SkillHistory skill={SKILL} />));
    expect(await screen.findByText('What changed from #1 to #2')).toBeTruthy();
    expect(screen.getByText('Use tests.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Restore revision 2/ })).toBeNull();
  });

  it('restores an older revision after confirmation', async () => {
    let restored = 0;
    setupFetchMock({
      'GET /api/v1/platform/skills/s1/revisions': revisions,
      'POST /api/v1/platform/skills/s1/revisions/1/restore': () => {
        restored++;
        return { data: { ...SKILL, currentRevision: 3 } };
      },
    });
    render(withQuery(<SkillHistory skill={SKILL} />));
    fireEvent.click(await screen.findByRole('button', { name: /Restore revision 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new revision' }));
    await waitFor(() => expect(restored).toBe(1));
    expect(await screen.findByText(/Saved as revision 3/)).toBeTruthy();
  });

  it('offers no restore for a built-in skill', async () => {
    setupFetchMock({ 'GET /api/v1/platform/skills/s1/revisions': revisions });
    render(withQuery(<SkillHistory skill={{ ...SKILL, isBuiltIn: true }} />));
    await screen.findByText('What changed from #1 to #2');
    expect(screen.queryByRole('button', { name: /Restore revision/ })).toBeNull();
  });
});
