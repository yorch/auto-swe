// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { CreateEvalDatasetModal } from './CreateEvalDatasetModal';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

beforeAll(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  push.mockReset();
  vi.unstubAllGlobals();
});

const created = {
  caseCount: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  description: null,
  id: 'ds-9',
  name: 'Bench',
  scope: 'GLOBAL',
  slug: 'bench',
};

function fillCase(n: number) {
  fireEvent.change(screen.getByLabelText(new RegExp(`Prompt \\(case ${n}\\)`)), {
    target: { value: 'Fix the bug' },
  });
  fireEvent.change(screen.getByLabelText(new RegExp(`Repository URL \\(case ${n}\\)`)), {
    target: { value: 'https://github.com/acme/app' },
  });
  fireEvent.change(screen.getByLabelText(new RegExp(`Baseline commit \\(case ${n}\\)`)), {
    target: { value: 'abc123' },
  });
  fireEvent.change(screen.getByLabelText(new RegExp(`Golden test \\(case ${n}\\)`)), {
    target: { value: 'yarn test' },
  });
}

function renderOpen() {
  render(withQuery(<CreateEvalDatasetModal onClose={vi.fn()} open />));
}

describe('CreateEvalDatasetModal', () => {
  it('keeps Create disabled until the dataset and every case satisfy the schema', () => {
    renderOpen();
    const submit = screen.getByRole('button', { name: 'Create dataset' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Bench' } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'Bad Slug' } });
    expect(screen.getByText('Lowercase letters, digits, - and _ only.')).toBeTruthy();
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'bench' } });
    expect(submit.disabled).toBe(true); // case 1 is still blank
    expect(screen.getByText(/Case 1: Add the task prompt/)).toBeTruthy();
    fillCase(1);
    expect(submit.disabled).toBe(false);
  });

  it('adds and removes cases', () => {
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Add case' }));
    expect(screen.getByLabelText(/Prompt \(case 2\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove case 1' }));
    expect(screen.queryByLabelText(/Prompt \(case 2\)/)).toBeNull();
    expect(screen.getByLabelText(/Prompt \(case 1\)/)).toBeTruthy();
  });

  it('posts the dataset with its cases and opens the new dataset page', async () => {
    const spy = setupFetchMock({ 'POST /api/v1/platform/evals': () => ({ data: created }) });
    renderOpen();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Bench' } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'bench' } });
    fillCase(1);
    fireEvent.change(screen.getByLabelText(/Expectations \(case 1\)/), {
      target: { value: 'tests pass' },
    });
    fireEvent.change(screen.getByLabelText(/Tags \(case 1\)/), {
      target: { value: 'api, smoke ,' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create dataset' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/evals/datasets/ds-9'));
    expect(bodyOf(spy, '/platform/evals')).toEqual({
      cases: [
        {
          baselineSha: 'abc123',
          goldenTest: 'yarn test',
          input: 'Fix the bug',
          reference: 'tests pass',
          repoUrl: 'https://github.com/acme/app',
          stack: null,
          tags: ['api', 'smoke'],
        },
      ],
      description: null,
      name: 'Bench',
      scope: 'GLOBAL',
      slug: 'bench',
    });
  });

  it('shows the API error and stays open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'CONFLICT', message: 'Slug already exists' } }),
            { headers: { 'content-type': 'application/json' }, status: 409 }
          )
      )
    );
    renderOpen();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Bench' } });
    fireEvent.change(screen.getByLabelText(/^Slug/), { target: { value: 'bench' } });
    fillCase(1);
    fireEvent.click(screen.getByRole('button', { name: 'Create dataset' }));
    expect(await screen.findByText(/Slug already exists|could not be created/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
