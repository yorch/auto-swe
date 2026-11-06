'use client';

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useRetryReviewFix, useReviewChoices, useRunReview } from '@/hooks/useCodeReview';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';

const reasons: Record<string, string> = {
  REVIEW_DISABLED: 'Code reviews are disabled for this repository.',
  REVIEW_HEAD_CHANGED: 'The branch moved since this run finished. Review the newer run instead.',
  REVIEW_NOTHING_TO_REVIEW:
    'This run has no PR, recorded branch head, or stored agent diff to review.',
  REVIEW_PRESET_DISABLED: 'This preset is disabled. Choose another preset.',
  REVIEW_PRESET_NOT_FOUND: 'This preset is no longer available.',
  REVIEW_SOURCE_IS_REVIEW: 'A review run cannot itself be reviewed.',
  REVIEW_SOURCE_NOT_FINISHED: 'Wait for this run to finish before requesting a review.',
  REVIEW_TEMPLATE_INVALID: 'Choose an active review template.',
};
export function reviewError(error: unknown): string {
  return error instanceof ApiError && error.code
    ? (reasons[error.code] ?? errMsg(error))
    : errMsg(error);
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function LaunchReview({ runId, onClose }: { runId: string; onClose: () => void }) {
  const choices = useReviewChoices();
  const launch = useRunReview(runId);
  const router = useRouter();
  const [advanced, setAdvanced] = useState(false);
  const [preset, setPreset] = useState('');
  const [template, setTemplate] = useState('');
  const options = advanced ? (choices.data?.templates ?? []) : (choices.data?.data ?? []);
  const selected = (advanced ? template : preset) || options[0]?.id || '';
  return (
    <Modal
      onClose={() => {
        if (!launch.isPending) {
          onClose();
        }
      }}
      open
      title="Run review"
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!selected || launch.isPending) {
            return;
          }
          launch.mutate(advanced ? { templateId: selected } : { presetId: selected }, {
            onSuccess: (result) => {
              router.push(`/runs/${result.runId}`);
              onClose();
            },
          });
        }}
      >
        <ToggleSwitch
          checked={advanced}
          label="Advanced: choose a review template"
          onChange={() => setAdvanced(!advanced)}
        />
        <QueryBoundary {...choices} label="review choices" onRetry={() => choices.refetch()}>
          {options.length ? (
            <Select
              label={advanced ? 'Review template' : 'Review preset'}
              onChange={advanced ? setTemplate : setPreset}
              options={options.map((o) => ({ label: o.name, value: o.id }))}
              value={selected}
            />
          ) : (
            <p className="text-sm text-paper-400">
              {advanced
                ? 'No active review templates are available.'
                : 'No enabled presets are available. Use Advanced to choose a review template.'}
            </p>
          )}
        </QueryBoundary>
        {launch.error && <Alert>{reviewError(launch.error)}</Alert>}
        <ModalFooter
          disabled={!selected || choices.isError || choices.isLoading}
          isPending={launch.isPending}
          onCancel={onClose}
          submitLabel="Run review"
        />
      </form>
    </Modal>
  );
}

function RetryFixButton({ runId }: { runId: string }) {
  const retryFix = useRetryReviewFix(runId);
  return (
    <>
      <Button
        disabled={retryFix.isPending || retryFix.isSuccess}
        onClick={() => retryFix.mutate()}
        variant="secondary"
      >
        {retryFix.isSuccess ? 'Fix retry queued' : 'Retry fix'}
      </Button>
      {retryFix.isError && <Alert variant="error">{reviewError(retryFix.error)}</Alert>}
    </>
  );
}

export function RunReviews({ run }: { run: WorkflowRunDetail }) {
  const [open, setOpen] = useState(false);
  const summary = record(
    [...run.steps]
      .sort((a, b) => b.attempt - a.attempt)
      .find((s) => s.stepName === 'publishReviewResult' && s.status === 'PASSED')?.outputs
  );
  const fix = record(summary.fix);
  const change = record(
    [...run.steps]
      .sort((a, b) => b.attempt - a.attempt)
      .find((step) => step.stepName === 'loadChangeForReview' && step.status === 'PASSED')?.outputs
  );
  const review = run.review;
  if (!review) {
    return null;
  }
  const blocked =
    review.canControl !== true
      ? 'You do not have permission to control this run.'
      : !review.reviewable
        ? (reasons[review.reason ?? ''] ?? review.reason ?? 'This run has nothing to review.')
        : undefined;
  const findings = Array.isArray(summary.findings)
    ? [
        ...new Set(
          summary.findings
            .map((finding) => {
              const f = record(finding);
              return [f.severity, f.file, f.line, f.description]
                .filter((v) => typeof v === 'string' || typeof v === 'number')
                .join(' · ');
            })
            .filter(Boolean)
        ),
      ]
    : [];
  return (
    <Card className="mx-4 my-3 shrink-0 md:mx-6">
      <CardHeader>
        <CardTitle>Reviews</CardTitle>
        <span title={blocked}>
          <Button disabled={Boolean(blocked)} onClick={() => setOpen(true)} variant="secondary">
            Run review
          </Button>
        </span>
      </CardHeader>
      {review.reviewOf && (
        <div className="mb-4 space-y-2 text-sm">
          <p>
            Review of run{' '}
            <Link className="text-accent-400 underline" href={`/runs/${review.reviewOf.runId}`}>
              {review.reviewOf.templateName}
            </Link>
          </p>
          {typeof change.diffVerified === 'boolean' && (
            <p>
              Change {change.diffVerified ? 'verified' : 'unverified'}
              {typeof change.verificationReason === 'string'
                ? `: ${change.verificationReason}`
                : ''}
            </p>
          )}
          {typeof summary.approved === 'boolean' ? (
            <>
              <p>
                {summary.approved ? 'Approved' : 'Changes requested'} · Worst severity:{' '}
                {typeof summary.worstSeverity === 'string' ? summary.worstSeverity : 'None'}
              </p>
              {findings.length ? (
                <ul className="list-disc space-y-1 pl-5">
                  {findings.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              ) : (
                <p>No findings reported.</p>
              )}
              {typeof fix.status === 'string' && (
                <p>
                  Fix {fix.status}
                  {typeof fix.reason === 'string' ? `: ${fix.reason}` : ''}
                  {typeof fix.workflowId === 'string' ? ` · ${fix.workflowId}` : ''}
                </p>
              )}
              {review.canControl && review.fixRetry?.allowed && (
                <RetryFixButton key={String(fix.attemptId ?? 'initial')} runId={run.id} />
              )}
            </>
          ) : (
            <p>No published verdict yet.</p>
          )}
        </div>
      )}
      <DataTable
        caption="Linked reviews"
        columns={[
          {
            cell: (r) => r.presetName ?? r.templateName,
            header: 'Review',
            id: 'name',
            primary: true,
          },
          { cell: (r) => r.status, header: 'Status', id: 'status' },
          {
            cell: (r) =>
              r.approved === null ? 'Pending' : r.approved ? 'Approved' : 'Changes requested',
            header: 'Verdict',
            id: 'approval',
          },
          { cell: (r) => r.worstSeverity ?? '—', header: 'Worst severity', id: 'severity' },
        ]}
        empty={<p className="text-sm text-paper-500">No reviews yet.</p>}
        getRowId={(r) => r.runId}
        rowHref={(r) => `/runs/${r.runId}`}
        rows={review.reviews}
      />
      {open && <LaunchReview onClose={() => setOpen(false)} runId={run.id} />}
    </Card>
  );
}
