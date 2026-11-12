// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { RunLessons } from './RunLessons';

const lesson = (over: Record<string, unknown> = {}) => ({
  canFlag: true,
  canManage: false,
  confidence: null,
  consolidatedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  failureType: 'CI_FAILURE',
  flagCount: 0,
  id: 'l1',
  lessonSummary: 'Run migrations before deploying',
  metadata: null,
  myFlag: null,
  quarantinedAt: null,
  quarantinedById: null,
  quarantineReason: null,
  quarantineSource: null,
  rationale: null,
  supersededAt: null,
  ...over,
});

function mock(data: unknown) {
  return setupFetchMock({
    'GET /api/v1/workflow-runs/run-1/lessons': () => ({ data }),
    'POST /api/v1/lessons/l1/flags': () => ({ data: {} }),
    'POST /api/v1/lessons/l1/quarantine': () => ({ data: {} }),
    'POST /api/v1/lessons/l1/restore': () => ({ data: {} }),
  });
}

beforeEach(() => stubDialogPrototype());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RunLessons', () => {
  it('lets a repository reader flag a historical lesson without manager controls', async () => {
    const fetchSpy = mock({ recalled: [], written: [lesson()] });
    render(withQuery(<RunLessons live={false} runId="run-1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Flag' }));
    fireEvent.change(await screen.findByLabelText('What is wrong with it'), {
      target: { value: 'wrong advice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Flag lesson' }));
    await vi.waitFor(() =>
      expect(bodyOf(fetchSpy, '/api/v1/lessons/l1/flags')).toEqual({ reason: 'wrong advice' })
    );
    expect(screen.queryByRole('button', { name: 'Quarantine' })).toBeNull();
  });

  it('lets managers quarantine lessons from the run panel', async () => {
    const fetchSpy = mock({ recalled: [], written: [lesson({ canManage: true })] });
    render(withQuery(<RunLessons live={false} runId="run-1" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Quarantine' }));
    fireEvent.change(await screen.findByLabelText('What is wrong with it'), {
      target: { value: 'stale advice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Quarantine lesson' }));
    await vi.waitFor(() =>
      expect(bodyOf(fetchSpy, '/api/v1/lessons/l1/quarantine')).toEqual({ reason: 'stale advice' })
    );
  });

  it('labels quarantined run lessons and offers manager restore', async () => {
    const fetchSpy = mock({
      recalled: [],
      written: [
        lesson({
          canManage: true,
          quarantinedAt: '2026-10-01T00:00:00Z',
          quarantineReason: 'Obsolete',
          quarantineSource: 'MANUAL',
        }),
      ],
    });
    render(withQuery(<RunLessons live={false} runId="run-1" />));
    expect(await screen.findByText('Quarantined')).toBeTruthy();
    expect(screen.getByText(/Obsolete/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore lesson' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await vi.waitFor(() => expect(bodyOf(fetchSpy, '/api/v1/lessons/l1/restore')).toEqual({}));
  });

  it('does not offer flagging without current repository access', async () => {
    mock({ recalled: [], written: [lesson({ canFlag: false })] });
    render(withQuery(<RunLessons live={false} runId="run-1" />));
    await screen.findByText('Run migrations before deploying');
    expect(screen.queryByRole('button', { name: 'Flag' })).toBeNull();
  });
  it('names what each recalled lesson said and which agents were given it', async () => {
    mock({
      recalled: [
        { lesson: lesson({ confidence: 0.3 }), lessonId: 'l1', recalledFor: ['implementer'] },
        { lesson: null, lessonId: 'l2', recalledFor: ['reviewer'] },
      ],
      written: [lesson({ id: 'l3', lessonSummary: 'Pin the base image' })],
    });
    render(withQuery(<RunLessons live={false} runId="run-1" />));
    expect(await screen.findByText('Run migrations before deploying')).toBeTruthy();
    expect(screen.getByText('2 recalled, 1 written')).toBeTruthy();
    expect(screen.getByText('Recalled by implementer')).toBeTruthy();
    expect(screen.getByText('Low confidence')).toBeTruthy();
    expect(screen.getByText(/A lesson since deleted/)).toBeTruthy();
    expect(screen.getByText('Pin the base image')).toBeTruthy();
  });

  it('says when a recalled lesson has since been merged or replaced', async () => {
    mock({
      recalled: [
        {
          lesson: lesson({ supersededAt: '2026-09-02T00:00:00.000Z' }),
          lessonId: 'l1',
          recalledFor: [],
        },
      ],
      written: [],
    });
    render(withQuery(<RunLessons live={false} runId="run-1" />));
    expect(await screen.findByText('No longer recalled')).toBeTruthy();
  });

  it('renders nothing for a run that neither recalled nor wrote a lesson', async () => {
    mock({ recalled: [], written: [] });
    const { container } = render(withQuery(<RunLessons live={false} runId="run-1" />));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe('');
  });
});
