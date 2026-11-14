// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { EvalScheduleForm } from './EvalScheduleForm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const config = {
  baselineRef: 'last-release',
  candidateRef: 'main',
  cronExpression: '0 7 * * *',
  datasetSlug: 'swe-implementer-golden',
  enabled: false,
  schedule: { exists: true, lastRunAt: null, nextRunAt: null, paused: true },
};

describe('EvalScheduleForm', () => {
  it('loads the schedule, saves edited refs and starts a run now', async () => {
    const spy = setupFetchMock({
      'GET /api/v1/platform/config/eval-schedule': () => ({ data: config }),
      'POST /api/v1/platform/config/eval-schedule/trigger': () => ({ data: { triggered: true } }),
      'PUT /api/v1/platform/config/eval-schedule': () => ({ data: config }),
    });
    render(withQuery(<EvalScheduleForm />));

    const candidate = (await screen.findByLabelText('Candidate ref')) as HTMLInputElement;
    expect(candidate.value).toBe('main');
    expect((screen.getByLabelText('Dataset slug') as HTMLInputElement).value).toBe(
      'swe-implementer-golden'
    );

    fireEvent.change(candidate, { target: { value: 'release-2' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(bodyOf(spy, '/config/eval-schedule', 'PUT')).toEqual({
        baselineRef: 'last-release',
        candidateRef: 'release-2',
        cronExpression: '0 7 * * *',
        datasetSlug: 'swe-implementer-golden',
        enabled: false,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('Eval run started.')).toBeTruthy();
  });
});
