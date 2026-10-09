// @vitest-environment jsdom

import { WORKFLOW_RUN_FAILED } from '@auto-swe/shared/automation';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fires: [] as unknown[], retried: [] as string[] }));

vi.mock('@/hooks/useAutomations', () => ({
  useAutomationFires: () => ({ data: state.fires, isError: false, isLoading: false }),
  useRetryAutomationFire: () => ({
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    mutate: (id: string) => state.retried.push(id),
  }),
}));

import { AutomationHistory } from './AutomationHistory';

const fire = (id: string, outcome: string, retriedAt: string | null = null) => ({
  createdAt: new Date().toISOString(),
  facts: { branch: 'main', event: 'push', runAttempt: 1, runId: id, workflowPath: 'ci.yml' },
  id,
  outcome,
  reason: null,
  retriedAt,
  scopeKey: 'main',
  subjectKey: 'a'.repeat(40),
  temporalWorkflowId: null,
  workRequestId: null,
});

beforeEach(() => {
  state.retried = [];
  state.fires = [
    fire('1', 'STARTED'),
    fire('2', 'FAILED_TO_START'),
    fire('3', 'SUPPRESSED_COOLDOWN', new Date().toISOString()),
  ];
});

describe('AutomationHistory', () => {
  it('offers managers to take again only a decision that started nothing and was not retried', () => {
    render(<AutomationHistory automationId="a" canManage source={WORKFLOW_RUN_FAILED} />);
    const buttons = screen.getAllByRole('button', { name: /Decide again/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(state.retried).toEqual(['2']);
    expect(screen.getByText('retried')).toBeTruthy();
  });

  it('offers nothing to someone who may only read', () => {
    render(<AutomationHistory automationId="a" source={WORKFLOW_RUN_FAILED} />);
    expect(screen.queryByRole('button', { name: /Decide again/ })).toBeNull();
  });
});
