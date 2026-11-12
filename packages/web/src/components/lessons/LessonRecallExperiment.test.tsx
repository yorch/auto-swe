// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLessonRecallExperiment } from '@/hooks/useLessons';
import { LessonRecallExperiment } from './LessonRecallExperiment';

vi.mock('@/hooks/useLessons', () => ({ useLessonRecallExperiment: vi.fn() }));
const query = vi.mocked(useLessonRecallExperiment);
const repos = [
  { id: 'repo-1', organizationName: 'acme', repoName: 'api' },
  { id: 'repo-2', organizationName: 'acme', repoName: 'web' },
];
const summary = {
  failureRate: 0.5,
  gateKnownCount: 2,
  gatePassRate: 0.5,
  heldOutCount: 0,
  meanCostUsd: 2,
  meanFixLoopIterations: 1,
  mergeKnownCount: 1,
  mergeRate: 1,
  outcomeKnownCount: 2,
  runCount: 2,
  successRate: 0.5,
};
const difference = { difference: 0.1, lower95: -0.3, upper95: 0.5 };
const comparison = {
  gatePassRateDifference: difference,
  mergeRateDifference: null,
  smallSample: true,
  successRateDifference: difference,
};
const data = {
  arms: { OFF: summary, ON: summary, SHADOW: { ...summary, heldOutCount: 1 } },
  caveat: 'Observational comparison, not a causal effect.',
  comparison,
  likeForLike: { comparison, ON: summary, SHADOW: summary },
  since: '2026-11-01T00:00:00.000Z',
  smallSampleWarning: 'Fewer than 30 runs is a small sample.',
};

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReturnValue({ data, error: null, isLoading: false } as ReturnType<
    typeof useLessonRecallExperiment
  >);
});
describe('LessonRecallExperiment', () => {
  it('shows rates, denominators, costs, held-out counts, like-for-like subsets, warning and 95% intervals', () => {
    render(<LessonRecallExperiment repositories={repos} />);
    expect(screen.getByText('Observational comparison, not a causal effect.')).toBeTruthy();
    expect(screen.getByText('Fewer than 30 runs is a small sample.')).toBeTruthy();
    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(within(tables[0]).getAllByRole('row')).toHaveLength(4);
    expect(within(tables[1]).getAllByRole('row')).toHaveLength(3);
    expect(within(tables[0]).getAllByText('50.0% (n=2)').length).toBe(9);
    expect(
      screen.getByText('Success rate ON − SHADOW: 10.0 percentage points (95% CI -30.0 to 50.0)')
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Matched success rate ON − SHADOW: 10.0 percentage points (95% CI -30.0 to 50.0)'
      )
    ).toBeTruthy();
    expect(screen.getByText(/Merge rate ON − SHADOW: not estimable/)).toBeTruthy();
    expect(screen.getAllByText('$2.0000')).toHaveLength(5);
  });
  it('renders unknown metrics instead of zero for an empty report', () => {
    const empty = {
      ...summary,
      failureRate: null,
      gateKnownCount: 0,
      gatePassRate: null,
      meanCostUsd: null,
      meanFixLoopIterations: null,
      mergeKnownCount: 0,
      mergeRate: null,
      outcomeKnownCount: 0,
      runCount: 0,
      successRate: null,
    };
    query.mockReturnValue({
      data: { ...data, arms: { OFF: empty, ON: empty, SHADOW: empty } },
      error: null,
      isLoading: false,
    } as ReturnType<typeof useLessonRecallExperiment>);
    render(<LessonRecallExperiment repositories={repos} />);
    expect(screen.getAllByText('Unknown (n=0)')).toHaveLength(12);
  });
  it('shows pending/error states and does not invent outcomes', () => {
    query.mockReturnValue({ data: undefined, error: null, isLoading: true } as ReturnType<
      typeof useLessonRecallExperiment
    >);
    const view = render(<LessonRecallExperiment repositories={repos} />);
    expect(screen.getByText('Loading recall outcomes…')).toBeTruthy();
    query.mockReturnValue({
      data: undefined,
      error: new Error('Access denied'),
      isLoading: false,
    } as ReturnType<typeof useLessonRecallExperiment>);
    view.rerender(<LessonRecallExperiment repositories={repos} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Cannot load recall outcomes: Access denied'
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('changes the date used to request outcomes and hides itself with no managed repository', () => {
    const view = render(<LessonRecallExperiment repositories={repos} />);
    fireEvent.change(screen.getByLabelText('Runs started since'), {
      target: { value: '2026-11-02' },
    });
    expect(query).toHaveBeenLastCalledWith('repo-1', '2026-11-02');
    view.rerender(<LessonRecallExperiment repositories={[]} />);
    expect(screen.queryByText('Lesson recall outcome comparison')).toBeNull();
    expect(query).toHaveBeenLastCalledWith(undefined, '2026-11-02');
  });
});
