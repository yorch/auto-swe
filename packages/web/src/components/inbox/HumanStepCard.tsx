'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { useRespondToHumanStep } from '@/hooks/useWorkflows';

const KIND_LABEL: Record<string, string> = {
  APPROVAL: 'Approval',
  DECISION: 'Decision',
  INPUT: 'Input',
  REVIEW: 'Review',
};

const KIND_COLOR: Record<string, string> = {
  APPROVAL: 'bg-amber-100 text-amber-700',
  DECISION: 'bg-blue-100 text-blue-700',
  INPUT: 'bg-green-100 text-green-700',
  REVIEW: 'bg-purple-100 text-purple-700',
};

export interface HumanStepCardProps {
  step: HumanStepSummary;
  showRunLink?: boolean;
}

export function HumanStepCard({ step, showRunLink = true }: HumanStepCardProps) {
  const respond = useRespondToHumanStep();
  const [expanded, setExpanded] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [reviewText, setReviewText] = useState(() => String(step.context ?? ''));

  function handleRespond(action: string, value?: unknown) {
    respond.mutate({ action, id: step.id, value });
    setExpanded(false);
  }

  return (
    <div className="border border-[var(--border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${KIND_COLOR[step.kind] ?? 'bg-gray-100 text-gray-600'}`}
        >
          {KIND_LABEL[step.kind] ?? step.kind}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{step.title}</div>
          {step.description && (
            <div className="text-xs text-[var(--muted-foreground)] mt-0.5">{step.description}</div>
          )}
          {showRunLink && (
            <div className="text-xs text-[var(--muted-foreground)] mt-1">
              {step.run.workRequest?.externalTicketId && (
                <span className="font-mono">{step.run.workRequest.externalTicketId} · </span>
              )}
              <Link className="underline" href={`/runs/${step.run.id}`}>
                View run
              </Link>
            </div>
          )}
        </div>
        <button
          className="text-xs px-2 py-1 border border-[var(--border)] rounded hover:bg-[var(--muted)]"
          onClick={() => setExpanded((v) => !v)}
          type="button"
        >
          {expanded ? 'Hide' : 'Respond'}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-[var(--border)] pt-3 space-y-3">
          {step.kind === 'APPROVAL' && (
            <div className="flex gap-2">
              <button
                className="px-4 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50"
                disabled={respond.isPending}
                onClick={() => handleRespond('approve')}
                type="button"
              >
                Approve
              </button>
              <button
                className="px-4 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50"
                disabled={respond.isPending}
                onClick={() => handleRespond('reject')}
                type="button"
              >
                Reject
              </button>
            </div>
          )}

          {step.kind === 'DECISION' && (
            <div className="flex flex-wrap gap-2">
              {(step.options as Array<{ label: string; value: string }> | null)?.map((opt) => (
                <button
                  className="px-3 py-1.5 border border-[var(--border)] text-sm rounded hover:bg-[var(--muted)] disabled:opacity-50"
                  disabled={respond.isPending}
                  key={opt.value}
                  onClick={() => handleRespond('select', opt.value)}
                  type="button"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {step.kind === 'INPUT' && (
            <div className="space-y-2">
              {(
                step.fields as Array<{
                  key: string;
                  label: string;
                  type: string;
                  required?: boolean;
                  options?: string[];
                }> | null
              )?.map((field) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: label wraps a conditional input/select/checkbox — biome can't statically trace through the ternary
                <label className="block space-y-0.5" key={field.key}>
                  <span className="text-xs font-medium block">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-0.5">*</span>}
                  </span>
                  {field.type === 'boolean' ? (
                    <input
                      checked={Boolean(inputValues[field.key])}
                      onChange={(e) =>
                        setInputValues((p) => ({ ...p, [field.key]: e.target.checked }))
                      }
                      type="checkbox"
                    />
                  ) : field.type === 'select' ? (
                    <select
                      className="w-full text-sm border border-[var(--border)] rounded px-2 py-1"
                      onChange={(e) =>
                        setInputValues((p) => ({ ...p, [field.key]: e.target.value }))
                      }
                      value={String(inputValues[field.key] ?? '')}
                    >
                      <option value="">—</option>
                      {field.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="w-full text-sm border border-[var(--border)] rounded px-2 py-1 font-mono"
                      onChange={(e) =>
                        setInputValues((p) => ({
                          ...p,
                          [field.key]:
                            field.type === 'number' ? Number(e.target.value) : e.target.value,
                        }))
                      }
                      type={field.type === 'number' ? 'number' : 'text'}
                      value={String(inputValues[field.key] ?? '')}
                    />
                  )}
                </label>
              ))}
              <button
                className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
                disabled={respond.isPending}
                onClick={() => {
                  const fields = step.fields as Array<{ key: string }> | null;
                  const value = Object.fromEntries(
                    (fields ?? []).map((f) => [f.key, inputValues[f.key] ?? ''])
                  );
                  handleRespond('submit', value);
                }}
                type="button"
              >
                Submit
              </button>
            </div>
          )}

          {step.kind === 'REVIEW' && (
            <div className="space-y-2">
              <textarea
                className="w-full text-sm border border-[var(--border)] rounded px-2 py-1 font-mono resize-y"
                onChange={(e) => setReviewText(e.target.value)}
                rows={8}
                value={reviewText}
              />
              <button
                className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
                disabled={respond.isPending}
                onClick={() => handleRespond('submit', reviewText)}
                type="button"
              >
                Submit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
