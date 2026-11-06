// @vitest-environment jsdom
import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { RunReviews, reviewError } from './RunReviews';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
beforeEach(stubDialogPrototype);
const run = (over: Record<string, unknown> = {}) =>
  ({
    id: 'source-1',
    review: { canControl: true, reviewable: true, reviews: [] },
    steps: [],
    ...over,
  }) as unknown as WorkflowRunDetail;
describe('run reviews', () => {
  const retryable = (allowed = true, canControl = true) =>
    run({
      review: {
        canControl,
        fixRetry: { allowed },
        reviewable: false,
        reviewOf: { runId: 'original', templateName: 'Source' },
        reviews: [],
      },
      steps: [
        {
          attempt: 1,
          outputs: {
            approved: false,
            fix: { reason: 'the fix launch failed', status: 'skipped' },
            worstSeverity: 'WARNING',
          },
          status: 'PASSED',
          stepName: 'publishReviewResult',
        },
      ],
    });
  it('queues a fix retry from the review verdict', async () => {
    const fetch = setupFetchMock({
      'POST /api/v1/workflow-runs/source-1/reviews/fix-retry': () => ({
        data: { workflowId: 'retry' },
      }),
    });
    render(withQuery(<RunReviews run={retryable()} />));
    fireEvent.click(screen.getByRole('button', { name: 'Retry fix' }));
    await screen.findByRole('button', { name: 'Fix retry queued' });
    expect(fetch.mock.calls.some((call) => String(call[0]).endsWith('/reviews/fix-retry'))).toBe(
      true
    );
  });
  it.each([
    [false, true],
    [true, false],
  ])('hides a fix retry without eligibility or control', (allowed, canControl) => {
    render(withQuery(<RunReviews run={retryable(allowed, canControl)} />));
    expect(screen.queryByRole('button', { name: 'Retry fix' })).toBeNull();
  });
  it('shows retry errors without losing the verdict', async () => {
    setupFetchMock({
      'POST /api/v1/workflow-runs/source-1/reviews/fix-retry': () => {
        throw new Error('Retry offline');
      },
    });
    render(withQuery(<RunReviews run={retryable()} />));
    fireEvent.click(screen.getByRole('button', { name: 'Retry fix' }));
    await screen.findByText('Retry offline');
    expect(screen.getByText(/Changes requested/)).toBeTruthy();
  });
  it.each([false, true])(
    'launches the default preset for workflow and agent runs (agent=%s)',
    async (isAgentRun) => {
      const fetch = setupFetchMock({
        '/api/v1/review-presets': () => ({
          data: [{ id: 'preset-1', name: 'Default review' }],
          templates: [{ id: 'template-1', name: 'Code review' }],
        }),
        'POST /api/v1/workflow-runs/source-1/reviews': () => ({
          data: { runId: 'review-1', workflowId: 'wf-review' },
        }),
      });
      render(withQuery(<RunReviews run={run({ isAgentRun })} />));
      fireEvent.click(screen.getByRole('button', { name: 'Run review' }));
      const dialog = screen.getByRole('dialog');
      await within(dialog).findAllByText('Default review');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Run review' }));
      await waitFor(() => expect(push).toHaveBeenCalledWith('/runs/review-1'));
      const call = fetch.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ presetId: 'preset-1' });
      const headers = call?.[1]?.headers as Record<string, string> | undefined;
      expect(headers?.['Idempotency-Key']).toBeTruthy();
    }
  );
  it('offers advanced template launch when no presets exist', async () => {
    const fetch = setupFetchMock({
      '/api/v1/review-presets': () => ({
        data: [],
        templates: [{ id: 'template-1', name: 'Code review' }],
      }),
      '/api/v1/workflow-runs/source-1/reviews': () => ({ data: { runId: 'review-1' } }),
    });
    render(withQuery(<RunReviews run={run()} />));
    fireEvent.click(screen.getByRole('button', { name: 'Run review' }));
    await screen.findByText(/No enabled presets/);
    fireEvent.click(screen.getByRole('switch', { name: /Advanced/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run review' }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(
      JSON.parse(String(fetch.mock.calls.find((c) => c[1]?.method === 'POST')?.[1]?.body))
    ).toEqual({ templateId: 'template-1' });
  });
  it.each([
    [{ canControl: false, reviewable: true, reviews: [] }, 'You do not have permission'],
    [
      { canControl: true, reason: 'REVIEW_NOTHING_TO_REVIEW', reviewable: false, reviews: [] },
      'no PR',
    ],
  ])('disables unavailable launch with a reason tooltip', (review, reason) => {
    render(withQuery(<RunReviews run={run({ review })} />));
    const button = screen.getByRole('button', { name: 'Run review' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toContain(reason);
  });
  it('shows linked reviews and the published verdict including fix skips', () => {
    render(
      withQuery(
        <RunReviews
          run={run({
            review: {
              canControl: true,
              reviewable: false,
              reviewOf: { runId: 'original', templateName: 'Original run' },
              reviews: [
                {
                  approved: false,
                  presetName: 'Strict review',
                  runId: 'linked',
                  status: 'SUCCESS',
                  templateName: 'Code review',
                  worstSeverity: 'WARNING',
                },
              ],
            },
            steps: [
              {
                attempt: 1,
                outputs: {
                  approved: false,
                  findings: [{ description: 'Check null input', file: 'a.ts' }],
                  fix: { reason: 'round limit reached', status: 'skipped' },
                  worstSeverity: 'WARNING',
                },
                status: 'PASSED',
                stepName: 'publishReviewResult',
              },
            ],
          })}
        />
      )
    );
    expect(screen.getByRole('link', { name: 'Original run' }).getAttribute('href')).toBe(
      '/runs/original'
    );
    expect(screen.getAllByRole('link', { name: 'Strict review' })[0]?.getAttribute('href')).toBe(
      '/runs/linked'
    );
    expect(screen.getByText(/Check null input/)).toBeTruthy();
    expect(screen.getByText('Fix skipped: round limit reached')).toBeTruthy();
  });
  it('shows readable launch error codes without hiding unknown server errors', () => {
    expect(reviewError(new ApiError('raw', 409, 'REVIEW_PRESET_DISABLED'))).toContain('disabled');
    expect(reviewError(new ApiError('Permission denied', 403, 'FORBIDDEN'))).toBe(
      'Permission denied'
    );
  });
  it('keeps the dialog open and explains a rejected launch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: unknown, init?: RequestInit) =>
          new Response(
            JSON.stringify(
              init?.method === 'POST'
                ? { error: { code: 'REVIEW_PRESET_DISABLED', message: 'raw' } }
                : { data: [{ id: 'preset-1', name: 'Default review' }], templates: [] }
            ),
            {
              headers: { 'content-type': 'application/json' },
              status: init?.method === 'POST' ? 409 : 200,
            }
          )
      )
    );
    render(withQuery(<RunReviews run={run()} />));
    fireEvent.click(screen.getByRole('button', { name: 'Run review' }));
    const dialog = screen.getByRole('dialog');
    await within(dialog).findAllByText('Default review');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run review' }));
    expect(
      await within(dialog).findByText('This preset is disabled. Choose another preset.')
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
