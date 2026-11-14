// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { EvalRubrics } from './EvalRubrics';

beforeAll(() => stubDialogPrototype());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rubric = {
  createdAt: '2026-09-01T00:00:00.000Z',
  id: 'rub-1',
  isBuiltIn: true,
  promptText: 'Grade the patch for correctness.',
  scale: '0..1',
  scope: 'GLOBAL',
  slug: 'patch-quality',
  version: 1,
};

describe('EvalRubrics', () => {
  it('lists the rubrics with their scale, scope and built-in mark', async () => {
    setupFetchMock({ 'GET /api/v1/platform/evals/rubrics': () => ({ data: [rubric] }) });
    render(withQuery(<EvalRubrics />));
    expect(await screen.findByText('patch-quality')).toBeTruthy();
    expect(screen.getByText('Built in')).toBeTruthy();
    expect(screen.getByText(/Scale 0\.\.1/)).toBeTruthy();
    expect(screen.getByText('Grade the patch for correctness.')).toBeTruthy();
  });

  it('creates a global rubric and surfaces the scanner findings', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/platform/evals/rubrics': () => ({ data: [] }),
      'POST /api/v1/platform/evals/rubrics': () => ({
        data: { ...rubric, isBuiltIn: false, slug: 'strict' },
        scanWarnings: ['possible injection phrase'],
      }),
    });
    render(withQuery(<EvalRubrics />));
    expect(await screen.findByText('No judge rubrics yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New rubric' }));
    const create = screen.getByRole('button', { name: 'Create rubric' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Slug/), { target: { value: 'strict' } });
    fireEvent.change(screen.getByLabelText(/Prompt/), { target: { value: 'Be strict.' } });
    fireEvent.click(create);
    expect(await screen.findByText(/possible injection phrase/)).toBeTruthy();
    await waitFor(() =>
      expect(bodyOf(spy, '/evals/rubrics')).toEqual({
        promptText: 'Be strict.',
        scale: '0..1',
        scope: 'GLOBAL',
        slug: 'strict',
      })
    );
  });

  it('refuses a slug the gateway would reject', async () => {
    setupFetchMock({ 'GET /api/v1/platform/evals/rubrics': () => ({ data: [] }) });
    render(withQuery(<EvalRubrics />));
    fireEvent.click(await screen.findByRole('button', { name: 'New rubric' }));
    fireEvent.change(screen.getByLabelText(/Slug/), { target: { value: 'Not A Slug' } });
    expect(screen.getByText('Lowercase letters, digits, - and _ only.')).toBeTruthy();
  });
});
