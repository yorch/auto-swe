// @vitest-environment jsdom

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunSummary } from './RunSummary';

vi.mock('@/components/approvals/HumanStepCard', () => ({
  HumanStepCard: ({ step }: { step: { title: string } }) => <div>{step.title}</div>,
}));
vi.mock('./RunOutcomeCard', () => ({
  RunOutcomeCard: ({ result }: { result: unknown }) => (result ? <div>outcome card</div> : null),
}));
vi.mock('./FailureCard', () => ({
  FailureCard: ({ onJumpToFailure }: { onJumpToFailure?: () => void }) => (
    <button onClick={onJumpToFailure} type="button">
      failure card
    </button>
  ),
}));

afterEach(cleanup);

const mkRun = (over: Record<string, unknown> = {}) =>
  ({
    isAgentRun: false,
    result: null,
    status: 'RUNNING',
    templateName: 't',
    ...over,
  }) as never as WorkflowRunDetail;
const step = (title: string) => ({ id: title, title }) as never;
const failed = { error: 'boom', nodeId: 'build' } as unknown as WorkflowStepRecord;

function order(texts: string[]): number[] {
  const html = document.body.textContent ?? '';
  return texts.map((t) => html.indexOf(t));
}

describe('RunSummary', () => {
  it.each(['compact', 'full'] as const)(
    'orders approvals, result, then failure (%s)',
    (variant) => {
      render(
        <RunSummary
          answeredSteps={[step('Answered one')]}
          failedStep={failed}
          pendingSteps={[step('Pending one')]}
          run={mkRun({ result: { pr: 1 }, status: 'FAILED' })}
          variant={variant}
        />
      );
      const [pending, answeredAt, outcome, failure] = order([
        'Pending one',
        'Answered one',
        'outcome card',
        'failure card',
      ]);
      expect(pending).toBeGreaterThanOrEqual(0);
      expect(pending).toBeLessThan(answeredAt);
      expect(answeredAt).toBeLessThan(outcome);
      expect(outcome).toBeLessThan(failure);
      expect(screen.getByText('Responses')).toBeTruthy();
      expect(screen.getByText('Needs a response')).toBeTruthy();
    }
  );

  it('renders nothing when there is nothing to show', () => {
    const { container } = render(
      <RunSummary failedStep={null} pendingSteps={[]} run={mkRun()} variant="compact" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('passes the jump-to-failure callback to the failure card', () => {
    const jump = vi.fn();
    render(
      <RunSummary
        failedStep={failed}
        onJumpToFailure={jump}
        pendingSteps={[]}
        run={mkRun({ status: 'FAILED' })}
        variant="full"
      />
    );
    fireEvent.click(screen.getByText('failure card'));
    expect(jump).toHaveBeenCalledTimes(1);
  });

  it('folds the result and failure on a phone but never the approvals (full)', () => {
    render(
      <RunSummary
        failedStep={failed}
        pendingSteps={[step('Pending one')]}
        run={mkRun({ result: { pr: 1 }, status: 'FAILED' })}
        variant="full"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(screen.getByRole('button', { name: 'Show failure details' })).toBeTruthy();
    expect(screen.getByText('outcome card').parentElement?.className).toContain('max-lg:hidden');
    expect(screen.getByText('Pending one').closest('section')?.className).not.toContain(
      'max-lg:hidden'
    );
  });

  it('has no fold control in the compact variant', () => {
    render(
      <RunSummary
        failedStep={failed}
        pendingSteps={[]}
        run={mkRun({ status: 'FAILED' })}
        variant="compact"
      />
    );
    expect(screen.queryByRole('button', { name: /details/ })).toBeNull();
  });

  it('says how a compact attempt ended, and keeps its output one click away', () => {
    const { rerender } = render(
      <RunSummary
        failedStep={null}
        pendingSteps={[]}
        run={mkRun({ status: 'TIMED_OUT' })}
        variant="compact"
      />
    );
    expect(screen.getByText(/The attempt timed out/)).toBeTruthy();
    rerender(
      <RunSummary
        failedStep={null}
        pendingSteps={[]}
        run={mkRun({ result: 'done text', status: 'SUCCESS' })}
        variant="compact"
      />
    );
    expect(screen.getByText(/Execution finished/)).toBeTruthy();
    expect(screen.getByText('Recorded output')).toBeTruthy();
    rerender(
      <RunSummary
        failedStep={null}
        pendingSteps={[]}
        run={mkRun({ status: 'SUCCESS' })}
        variant="compact"
      />
    );
    expect(screen.getByText('No result was recorded for this attempt.')).toBeTruthy();
  });
});
