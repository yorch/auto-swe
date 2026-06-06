'use client';

import type { HumanStepSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useRespondToHumanStep } from '@/hooks/useWorkflows';

const KIND_LABEL: Record<string, string> = {
  APPROVAL: 'Approval',
  DECISION: 'Decision',
  INPUT: 'Input',
  REVIEW: 'Review',
};

const KIND_COLOR: Record<string, string> = {
  APPROVAL: 'bg-amber-400/20 text-amber-400',
  DECISION: 'bg-dust-400/20 text-dust-400',
  INPUT: 'bg-moss-400/20 text-moss-400',
  REVIEW: 'bg-violet-400/20 text-violet-400',
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
    <div className="border border-ink-600 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded shrink-0 ${KIND_COLOR[step.kind] ?? 'bg-ink-600 text-paper-400'}`}
        >
          {KIND_LABEL[step.kind] ?? step.kind}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{step.title}</div>
          {step.description && (
            <div className="text-xs text-paper-400 mt-0.5">{step.description}</div>
          )}
          {showRunLink && (
            <div className="text-xs text-paper-400 mt-1">
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
          className="text-xs px-2 py-1 border border-ink-600 rounded hover:bg-ink-800"
          onClick={() => setExpanded((v) => !v)}
          type="button"
        >
          {expanded ? 'Hide' : 'Respond'}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-ink-600 pt-3 space-y-3">
          {step.kind === 'APPROVAL' && (
            <div className="flex gap-2">
              <Button
                disabled={respond.isPending}
                onClick={() => handleRespond('approve')}
                size="sm"
                variant="primary"
              >
                Approve
              </Button>
              <Button
                disabled={respond.isPending}
                onClick={() => handleRespond('reject')}
                size="sm"
                variant="danger"
              >
                Reject
              </Button>
            </div>
          )}

          {step.kind === 'DECISION' && (
            <div className="flex flex-wrap gap-2">
              {(step.options as Array<{ label: string; value: string }> | null)?.map((opt) => (
                <Button
                  disabled={respond.isPending}
                  key={opt.value}
                  onClick={() => handleRespond('select', opt.value)}
                  size="sm"
                  variant="secondary"
                >
                  {opt.label}
                </Button>
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
                    {field.required && <span className="text-brick-400 ml-0.5">*</span>}
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
                      className="w-full text-sm border border-ink-600 rounded px-2 py-1"
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
                      className="w-full text-sm border border-ink-600 rounded px-2 py-1 font-mono"
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
              <Button
                disabled={respond.isPending}
                onClick={() => {
                  const fields = step.fields as Array<{ key: string }> | null;
                  const value = Object.fromEntries(
                    (fields ?? []).map((f) => [f.key, inputValues[f.key] ?? ''])
                  );
                  handleRespond('submit', value);
                }}
                size="sm"
                variant="primary"
              >
                Submit
              </Button>
            </div>
          )}

          {step.kind === 'REVIEW' && (
            <div className="space-y-2">
              <textarea
                className="w-full text-sm border border-ink-600 rounded px-2 py-1 font-mono resize-y"
                onChange={(e) => setReviewText(e.target.value)}
                rows={8}
                value={reviewText}
              />
              <Button
                disabled={respond.isPending}
                onClick={() => handleRespond('submit', reviewText)}
                size="sm"
                variant="primary"
              >
                Submit
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
