// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { NumberField, WorkflowDefaultsForm } from './WorkflowDefaultsForm';

afterEach(() => vi.unstubAllGlobals());

const saved = {
  branchPrefix: 'auto',
  budgetTiers: {
    EPIC: { inputTokens: 20_000_000, outputTokens: 5_000_000 },
    LARGE: { inputTokens: 8_000_000, outputTokens: 2_000_000 },
    STANDARD: { inputTokens: 2_000_000, outputTokens: 500_000 },
  },
  ciPollDeadlineSec: 14_400,
  ciPollGraceSec: 60,
  ciPollIntervalSec: 15,
  ciWaitMode: 'signal',
  defaultTeamSlug: 'default',
  evalHealthMaxFlakeRate: 0.1,
  evalHealthMaxStaleRate: 0.1,
  evalHealthMinKappa: 0.4,
  evalJudgeThreshold: 0.5,
  lessonRetrievalLimit: 5,
  lessonRetrievalThreshold: 0.7,
  maxEvalIterations: 3,
  maxTddIterations: 5,
  prBodyTemplate: 'Old body',
  prTitleTemplate: '[x] {{ticketId}}',
};

function mock() {
  return setupFetchMock({
    'GET /api/v1/platform/config/workflow-defaults': () => ({ data: saved }),
    'PUT /api/v1/platform/config/workflow-defaults': () => ({ data: saved }),
  });
}

describe('NumberField', () => {
  it('can be emptied and retyped, and reports the empty value as invalid', () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(
      <NumberField
        hint="h"
        id="n"
        label="Count"
        min={1}
        onChange={onChange}
        onValidityChange={onValidityChange}
        value={5}
      />
    );
    const input = screen.getByLabelText('Count') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(screen.getByText('Enter a number')).toBeTruthy();
    expect(onValidityChange).toHaveBeenLastCalledWith('n', true);
    // The form keeps its last good number rather than being told 0.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith(12);
    expect(onValidityChange).toHaveBeenLastCalledWith('n', false);
  });

  it('reports valid and shows no error while disabled, so it cannot block saving', () => {
    const onValidityChange = vi.fn();
    render(
      <NumberField
        disabled
        hint="h"
        id="n"
        label="Count"
        min={1}
        onChange={vi.fn()}
        onValidityChange={onValidityChange}
        value={5}
      />
    );
    const input = screen.getByLabelText('Count') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText('Enter a number')).toBeNull();
    expect(onValidityChange).toHaveBeenLastCalledWith('n', false);
  });

  it('flags a value outside its range and shows token counts with separators', () => {
    render(
      <NumberField
        hint="Cap."
        id="t"
        label="Tokens"
        max={10}
        min={1}
        onChange={() => {}}
        tokens
        value={5}
      />
    );
    expect(screen.getByText(/5 tokens/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tokens'), { target: { value: '11' } });
    expect(screen.getByText('Must be at most 10')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tokens'), { target: { value: '0' } });
    expect(screen.getByText('Must be at least 1')).toBeTruthy();
  });
});

describe('WorkflowDefaultsForm', () => {
  it('refuses to save a cleared branch prefix instead of silently keeping the old one', async () => {
    const spy = mock();
    render(withQuery(<WorkflowDefaultsForm />));
    const prefix = (await screen.findByLabelText('Branch prefix')) as HTMLInputElement;
    fireEvent.change(prefix, { target: { value: '' } });
    expect(screen.getByText(/cannot be cleared yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    expect(await screen.findByText('Fix the highlighted fields before saving.')).toBeTruthy();
    expect(
      spy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    ).toBe(false);
  });

  it('sends an emptied PR body template so it can be reverted to the default', async () => {
    const spy = mock();
    render(withQuery(<WorkflowDefaultsForm />));
    const body = await screen.findByLabelText('PR body template');
    fireEvent.change(body, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => {
      const put = spy.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT'
      );
      expect(put).toBeTruthy();
      const init = (put as unknown[])[1] as RequestInit;
      expect(JSON.parse(String(init.body)).prBodyTemplate).toBe('');
    });
  });

  it('disables the poll fields while the wait mode is signal', async () => {
    mock();
    render(withQuery(<WorkflowDefaultsForm />));
    expect(((await screen.findByLabelText('Poll interval (s)')) as HTMLInputElement).disabled).toBe(
      true
    );
  });
});
