// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { EvalSignalsPanel } from './EvalSignalsPanel';

afterEach(() => vi.unstubAllGlobals());

const row = (over: Record<string, unknown> = {}) => ({
  agentKey: null,
  createdAt: '2026-06-24T00:00:00.000Z',
  id: 'e1',
  metadata: null,
  nodeId: null,
  passed: true,
  rationale: null,
  runId: 'run-1',
  scorer: 'gate:runTests',
  scoreType: 'BOOLEAN',
  source: 'GATE',
  value: 1,
  ...over,
});

describe('EvalSignalsPanel', () => {
  it('lists captured signals, rendering BOOLEAN as pass/fail and NUMERIC as a score', async () => {
    setupFetchMock({
      'GET /api/v1/workflow-runs/run-1/eval-results': () => ({
        data: [
          row({ id: 'g', scorer: 'gate:runTests', scoreType: 'BOOLEAN', value: 1 }),
          row({
            id: 'r',
            passed: false,
            scorer: 'review:SECURITY',
            scoreType: 'NUMERIC',
            value: 0.5,
          }),
        ],
      }),
    });

    render(withQuery(<EvalSignalsPanel runId="run-1" />));

    await waitFor(() => expect(screen.getByText('gate:runTests')).toBeTruthy());
    expect(screen.getByText('pass')).toBeTruthy();
    expect(screen.getByText('review:SECURITY')).toBeTruthy();
    expect(screen.getByText('0.50')).toBeTruthy();
  });

  it('renders nothing when there are no captured signals', async () => {
    setupFetchMock({
      'GET /api/v1/workflow-runs/run-1/eval-results': () => ({ data: [] }),
    });

    const { container } = render(withQuery(<EvalSignalsPanel runId="run-1" />));
    await waitFor(() => expect(container.querySelector('.kicker')).toBeNull());
    expect(screen.queryByText('Eval signals')).toBeNull();
  });

  it('does not crash on non-numeric values', async () => {
    setupFetchMock({
      'GET /api/v1/workflow-runs/run-1/eval-results': () => ({
        data: [
          row({ id: 'bad-bool', scorer: 'gate:runTests', scoreType: 'BOOLEAN', value: 'yes' }),
          row({ id: 'bad-num', scorer: 'review:SECURITY', scoreType: 'NUMERIC', value: null }),
        ],
      }),
    });

    render(withQuery(<EvalSignalsPanel runId="run-1" />));
    await waitFor(() => expect(screen.getByText('gate:runTests')).toBeTruthy());
    expect(screen.getByText('yes')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });
});
