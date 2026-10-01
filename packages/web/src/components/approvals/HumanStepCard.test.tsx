// @vitest-environment jsdom

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanStepCard } from './HumanStepCard';

const mutate = vi.fn();
vi.mock('@/hooks/useApprovals', () => ({
  useRespondToApproval: () => ({ isPending: false, mutate, reset: vi.fn() }),
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

beforeEach(() => mutate.mockClear());

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
