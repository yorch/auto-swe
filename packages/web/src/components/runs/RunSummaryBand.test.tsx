// @vitest-environment jsdom

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunSummaryBand } from './RunSummaryBand';

vi.mock('@/components/approvals/HumanStepCard', () => ({
  HumanStepCard: ({
    step,
  }: {
    step: { title: string; responses?: { byName: string; comment: string }[] };
  }) => (
    <div>
      {step.title}
      {step.responses?.map((r) => (
        <span key={r.byName}>
          {r.byName}: {r.comment}
        </span>
      ))}
    </div>
  ),
}));

afterEach(cleanup);

const run = { isAgentRun: false, result: null, templateName: 't' } as unknown as WorkflowRunDetail;
const answered = {
  id: 'h1',
  responses: [{ action: 'reject', byName: 'Dana', comment: 'Wrong table', value: null }],
  status: 'REJECTED',
  title: 'Approve the migration',
} as never;

describe('RunSummaryBand', () => {
  it('shows who answered an approval and what they said', () => {
    render(
      <RunSummaryBand answeredSteps={[answered]} failedStep={null} pendingSteps={[]} run={run} />
    );
    expect(screen.getByText('Responses')).toBeTruthy();
    expect(screen.getByText('Approve the migration')).toBeTruthy();
    expect(screen.getByText('Dana: Wrong table')).toBeTruthy();
  });

  it('renders nothing when there is nothing to show', () => {
    const { container } = render(<RunSummaryBand failedStep={null} pendingSteps={[]} run={run} />);
    expect(container.firstChild).toBeNull();
  });
});
