// @vitest-environment jsdom

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { HumanStepCard } from './HumanStepCard';

const mutate = vi.fn();
const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock('@/hooks/useApprovals', () => ({
  useRespondToApproval: () => ({ isPending: false, mutate, mutateAsync, reset: vi.fn() }),
}));

function inputStep(fields: unknown): HumanStepSummary {
  return {
    fields,
    id: 's1',
    kind: 'INPUT',
    nodeId: 'n1',
    requestedAt: new Date().toISOString(),
    run: { id: 'r1', status: 'RUNNING', workflowId: 'w1' },
    runId: 'r1',
    status: 'PENDING',
    title: 'Need input',
  };
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
}

beforeEach(() => {
  stubDialogPrototype();
  mutate.mockClear();
  mutateAsync.mockClear();
});

describe('HumanStepCard input fields', () => {
  it('submits an untouched required checkbox as false, without a Required error', () => {
    render(
      <HumanStepCard
        step={inputStep([{ key: 'ok', label: 'Confirm', required: true, type: 'boolean' }])}
      />
    );
    submit();
    expect(screen.queryByText(/Required:/)).toBeNull();
    expect(mutate.mock.calls[0][0]).toMatchObject({ action: 'submit', value: { ok: false } });
  });

  it('still rejects an empty required text field', () => {
    render(
      <HumanStepCard
        step={inputStep([{ key: 'why', label: 'Reason', required: true, type: 'text' }])}
      />
    );
    submit();
    expect(screen.getByRole('alert').textContent).toContain('Required: Reason');
    expect(mutate).not.toHaveBeenCalled();
  });
});

function approvalStep(overrides: Partial<HumanStepSummary> = {}): HumanStepSummary {
  return {
    context: 'diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y\n',
    id: 's2',
    kind: 'APPROVAL',
    nodeId: 'n1',
    requestedAt: new Date().toISOString(),
    run: { id: 'r1', status: 'RUNNING', workflowId: 'w1', workRequestId: 'wr1' },
    runId: 'r1',
    status: 'PENDING',
    title: 'Approve plan',
    ...overrides,
  };
}

describe('HumanStepCard approvals', () => {
  it('shows the context without a toggle', () => {
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    expect(screen.queryByText('Show context')).toBeNull();
    expect(screen.getAllByText('a.ts').length).toBeGreaterThan(0);
  });

  it('approve opens a dialog and sends the optional comment', () => {
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Comment (optional)'), {
      target: { value: 'Ship it' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      action: 'approve',
      comment: 'Ship it',
      id: 's2',
    });
  });

  it('reject needs a reason before it submits', () => {
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const submit = screen.getAllByRole('button', { name: 'Reject' }).at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: 'Wrong approach' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('says when the final approval is yours', () => {
    render(<HumanStepCard step={approvalStep({ currentApprovers: 1, requiredApprovers: 2 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText(/final required approval/)).toBeTruthy();
  });

  it('offers no response once you approved or the step expired', () => {
    const { unmount } = render(
      <HumanStepCard step={approvalStep({ myResponse: 'approve', requiredApprovers: 2 })} />
    );
    expect(screen.getByText('You approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Respond' })).toBeNull();
    unmount();
    render(
      <HumanStepCard
        step={approvalStep({ timeoutAt: new Date(Date.now() - 60_000).toISOString() })}
      />
    );
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Respond' })).toBeNull();
  });

  it('shows a recorded comment on a resolved step', () => {
    render(
      <HumanStepCard
        step={approvalStep({
          responses: [
            { action: 'reject', byName: 'Ada', comment: 'Wrong table', resolvedAt: null },
          ],
          status: 'RESOLVED',
        })}
      />
    );
    expect(screen.getByText('Wrong table')).toBeTruthy();
  });
});

describe('HumanStepCard dialog and responses', () => {
  it('locks the approve dialog against dismissal while the answer is being sent', async () => {
    mutateAsync.mockReturnValueOnce(new Promise(() => {}));
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const closeButton = () =>
      screen
        .getAllByLabelText('Close')
        .find((b) => b.closest('dialog')?.textContent?.includes('Approve Approve plan?')) as
        | HTMLButtonElement
        | undefined;
    expect(closeButton()?.disabled).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    await screen.findByText('Approving…');
    expect(closeButton()?.disabled).toBe(true);
  });

  it('caps the note and shows how much of it is used', () => {
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const note = screen.getByLabelText('Comment (optional)') as HTMLTextAreaElement;
    expect(note.maxLength).toBe(2000);
    fireEvent.change(note, { target: { value: 'abc' } });
    expect(screen.getByText('3 / 2000')).toBeTruthy();
  });

  it('labels a submitted review and shows what was submitted', () => {
    render(
      <HumanStepCard
        step={approvalStep({
          kind: 'REVIEW',
          responses: [
            {
              action: 'submit',
              byName: 'Grace',
              comment: null,
              resolvedAt: null,
              value: 'Needs a rollback plan',
            },
          ],
          status: 'RESOLVED',
        })}
      />
    );
    expect(screen.getByText(/Grace · Submitted/)).toBeTruthy();
    expect(screen.getByText('Needs a rollback plan')).toBeTruthy();
  });
});
