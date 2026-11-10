// @vitest-environment jsdom

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { HumanStepCard } from './HumanStepCard';

/** The button that opens a pending step is named for the kind of answer it takes. */
const RESPOND = /^(Review and decide|Choose|Fill in|Review)$/;
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
  fireEvent.click(screen.getByRole('button', { name: RESPOND }));
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

describe('HumanStepCard for a paused agent', () => {
  const asked = (): HumanStepSummary => ({
    ...inputStep([
      {
        key: 'q1',
        label: 'Which library?',
        options: ['Alpha', 'Beta'],
        required: true,
        type: 'select',
      },
      { key: 'q2', label: 'Which targets? (comma-separated)', required: true, type: 'text' },
      { key: 'note', label: 'Anything else the agent should know', type: 'text' },
    ]),
    context: 'Files changed: a.ts',
    description: 'The agent stopped to ask before it goes on:\n1. [Library] Which library?',
    nodeId: 'impl:ask:1',
    title: 'implementer needs input',
  });

  it('shows the work so far and the questions, with a select and text fields to answer them', () => {
    render(<HumanStepCard step={asked()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    expect(screen.getByText('Files changed: a.ts')).toBeTruthy();
    expect(screen.getByText(/The agent stopped to ask/)).toBeTruthy();
    expect(screen.getByLabelText(/Which library\?/)).toBeTruthy();
    expect(screen.getByLabelText(/Which targets\?/)).toBeTruthy();
  });

  it('does not submit until the required select and text are answered', () => {
    render(<HumanStepCard step={asked()} />);
    submit();
    expect(screen.getByRole('alert').textContent).toContain('Required:');
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
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    expect(screen.queryByText('Show context')).toBeNull();
    expect(screen.getAllByText('a.ts').length).toBeGreaterThan(0);
  });

  it('approve opens a dialog and sends the optional comment', () => {
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
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
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
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
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByText(/final required approval/)).toBeTruthy();
  });

  it('offers no response once you approved or the step expired', () => {
    const { unmount } = render(
      <HumanStepCard step={approvalStep({ myResponse: 'approve', requiredApprovers: 2 })} />
    );
    expect(screen.getByText('You approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: RESPOND })).toBeNull();
    unmount();
    render(
      <HumanStepCard
        step={approvalStep({ timeoutAt: new Date(Date.now() - 60_000).toISOString() })}
      />
    );
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: RESPOND })).toBeNull();
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
    // A reject settles the step too; it must not read as a green "resolved".
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.queryByText('Resolved')).toBeNull();
  });

  it('names the request by its description when the ticket id is a UUID', () => {
    render(
      <HumanStepCard
        showRunLink
        step={approvalStep({
          run: {
            id: 'r1',
            status: 'RUNNING',
            workflowId: 'w1',
            workRequest: {
              description: 'Add a health endpoint\nwith details',
              externalTicketId: '3f2b8c1a-1111-4222-8333-444455556666',
            },
            workRequestId: 'req-1',
          },
        })}
      />
    );
    expect(screen.getByText('Add a health endpoint')).toBeTruthy();
    expect(screen.queryByText(/3f2b8c1a/)).toBeNull();
  });
});

describe('HumanStepCard dialog and responses', () => {
  it('locks the approve dialog against dismissal while the answer is being sent', async () => {
    mutateAsync.mockReturnValueOnce(new Promise(() => {}));
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const closeButton = () =>
      screen
        .getAllByLabelText('Close')
        .find((b) => b.closest('dialog')?.textContent?.includes('Approve this step?')) as
        | HTMLButtonElement
        | undefined;
    expect(closeButton()?.disabled).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1) as HTMLElement);
    await screen.findByText('Approving…');
    expect(closeButton()?.disabled).toBe(true);
  });

  it('caps the note and shows how much of it is used', () => {
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
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

  it('offers Request changes only when the step carries the marker, and requires feedback', () => {
    // No marker -> no third button.
    render(<HumanStepCard step={approvalStep()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
  });

  it('request changes needs feedback before it submits and sends the comment', async () => {
    render(
      <HumanStepCard
        step={approvalStep({
          options: [{ label: 'Request changes', value: 'request_changes' }],
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    const submit = screen
      .getAllByRole('button', { name: 'Request changes' })
      .at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What should change? (required)'), {
      target: { value: 'Add a test' },
    });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await screen.findByText('Requesting…');
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      action: 'request_changes',
      comment: 'Add a test',
      id: 's2',
    });
  });
});

describe('HumanStepCard before it is opened', () => {
  it('shows what the change is, so a step can be judged without opening it', () => {
    render(<HumanStepCard step={approvalStep()} />);
    expect(screen.getByTestId('step-context-excerpt').textContent).toContain(
      '1 file changed (+1 −1): a.ts'
    );
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    expect(screen.queryByTestId('step-context-excerpt')).toBeNull();
  });

  it('labels the opening button by the kind of answer it takes', () => {
    render(<HumanStepCard step={approvalStep()} />);
    expect(screen.getByRole('button', { name: 'Review and decide' })).toBeTruthy();
  });

  it('can start open, for an inbox with a single waiting step', () => {
    render(<HumanStepCard defaultExpanded step={approvalStep()} />);
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('says what happens next once the deadline has passed', () => {
    render(
      <HumanStepCard
        step={approvalStep({ timeoutAt: new Date(Date.now() - 60_000).toISOString() })}
      />
    );
    expect(screen.getByText(/follows this step’s timeout route/)).toBeTruthy();
  });
});

describe('HumanStepCard decisions', () => {
  const decision = () =>
    approvalStep({
      context: null,
      kind: 'DECISION',
      options: [
        { label: 'Ship it', value: 'ship' },
        { label: 'Hold', value: 'hold' },
      ],
    });

  it('asks before a choice is sent, and sends it only on confirmation', () => {
    render(<HumanStepCard step={decision()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose “Ship it”' }));
    expect(mutate.mock.calls[0][0]).toMatchObject({ action: 'select', id: 's2', value: 'ship' });
  });

  it('sends nothing when the confirmation is cancelled', () => {
    render(<HumanStepCard step={decision()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    fireEvent.click(screen.getByRole('button', { name: 'Hold' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1) as HTMLElement);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('tells the inbox what was recorded', () => {
    const onAnswered = vi.fn();
    mutate.mockImplementationOnce((_input, options) => options?.onSuccess?.());
    render(<HumanStepCard onAnswered={onAnswered} step={decision()} />);
    fireEvent.click(screen.getByRole('button', { name: RESPOND }));
    fireEvent.click(screen.getByRole('button', { name: 'Ship it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose “Ship it”' }));
    expect(onAnswered).toHaveBeenCalledWith('Choice recorded for “Approve plan”.');
  });
});
