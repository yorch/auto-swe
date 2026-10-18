// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { RunLessons } from './RunLessons';

const lesson = (over: Record<string, unknown> = {}) => ({
  confidence: null,
  consolidatedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  failureType: 'CI_FAILURE',
  id: 'l1',
  lessonSummary: 'Run migrations before deploying',
  metadata: null,
  rationale: null,
  supersededAt: null,
  ...over,
});

function mock(data: unknown) {
  setupFetchMock({ 'GET /api/v1/workflow-runs/run-1/lessons': () => ({ data }) });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RunLessons', () => {
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
