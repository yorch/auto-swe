// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { EvalLessonImport } from './EvalLessonImport';

beforeAll(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DS_ID = '11111111-1111-4111-8111-111111111111';
const repos = [
  { id: 'r1', organizationName: 'acme', repoName: 'api', team: { id: 't1' }, type: 'git_repo' },
  { id: 'r2', organizationName: 'acme', repoName: 'web', team: { id: 't2' }, type: 'git_repo' },
];

function mock() {
  return setupFetchMock({
    'GET /api/v1/repositories': () => ({ data: repos, meta: { limit: 500, offset: 0, total: 2 } }),
    [`GET /api/v1/platform/evals/${DS_ID}`]: () => ({ data: {} }),
    [`POST /api/v1/platform/evals/${DS_ID}/lessons/import`]: () => ({ data: { count: 4 } }),
  });
}

describe('EvalLessonImport', () => {
  it('confirms before replacing the corpus, then imports from the chosen repository', async () => {
    const spy = mock();
    render(
      withQuery(
        <EvalLessonImport datasetId={DS_ID} lessonCount={2} teamId={null} teamScoped={false} />
      )
    );
    await screen.findByText('Import lessons', { selector: 'button' });
    // Nothing to import until a repository is chosen.
    expect(
      (screen.getByRole('button', { name: 'Import lessons' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Choose a repository/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'acme/api' }));
    fireEvent.change(screen.getByLabelText('Most lessons'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import lessons' }));
    expect(screen.getByText(/The 2 lessons in this dataset's corpus are replaced/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import and replace' }));
    expect(await screen.findByText('Imported 4 lessons.')).toBeTruthy();
    await waitFor(() =>
      expect(bodyOf(spy, `/evals/${DS_ID}/lessons/import`)).toEqual({ limit: 10, repoId: 'r1' })
    );
  });

  it('offers a team dataset only the repositories of its team', async () => {
    mock();
    render(
      withQuery(<EvalLessonImport datasetId={DS_ID} lessonCount={0} teamId="t2" teamScoped />)
    );
    await screen.findByText('Import lessons', { selector: 'button' });
    fireEvent.click(screen.getByRole('button', { name: /Choose a repository/ }));
    expect(await screen.findByRole('option', { name: 'acme/web' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'acme/api' })).toBeNull();
  });
});
