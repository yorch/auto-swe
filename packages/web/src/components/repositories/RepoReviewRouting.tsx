'use client';

import type { RepositoryReviewRouting } from '@auto-swe/shared/types/api';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useRepositoryReviewRouting, useSetRepositoryReviewRouting } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

type Override = RepositoryReviewRouting['override'];

interface Draft {
  humanAboveLines: string;
  humanMinRisk: string;
  humanPaths: string;
  quickReviewMaxLines: string;
  skipWhenBotApproved: string;
}

const RISK_LABEL = { HIGH: 'High', LOW: 'Low', STANDARD: 'Standard' } as const;

function toDraft(override: Override): Draft {
  return {
    humanAboveLines: override.humanAboveLines === undefined ? '' : String(override.humanAboveLines),
    humanMinRisk: override.humanMinRisk ?? '',
    humanPaths: (override.humanPaths ?? []).join('\n'),
    quickReviewMaxLines:
      override.quickReviewMaxLines === undefined ? '' : String(override.quickReviewMaxLines),
    skipWhenBotApproved:
      override.skipWhenBotApproved === undefined ? '' : String(override.skipWhenBotApproved),
  };
}

/** The override a draft describes; a blank field inherits and is left out. */
export function toOverride(draft: Draft): Override {
  const out: Override = {};
  if (
    draft.humanMinRisk === 'LOW' ||
    draft.humanMinRisk === 'STANDARD' ||
    draft.humanMinRisk === 'HIGH'
  ) {
    out.humanMinRisk = draft.humanMinRisk;
  }
  if (draft.humanAboveLines.trim() !== '') {
    out.humanAboveLines = Number(draft.humanAboveLines);
  }
  const paths = draft.humanPaths
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (paths.length > 0) {
    out.humanPaths = paths;
  }
  if (draft.quickReviewMaxLines.trim() !== '') {
    out.quickReviewMaxLines = Number(draft.quickReviewMaxLines);
  }
  if (draft.skipWhenBotApproved === 'true' || draft.skipWhenBotApproved === 'false') {
    out.skipWhenBotApproved = draft.skipWhenBotApproved === 'true';
  }
  return out;
}

/**
 * Who must review pull requests of this repository. The repository adds to the team's and
 * organization's routing settings and can only make it stricter, so a blank field inherits the
 * value in force. Saving replaces the whole override.
 */
export function RepoReviewRouting({
  disabled,
  repositoryId,
}: {
  disabled: boolean;
  repositoryId: string;
}) {
  const routing = useRepositoryReviewRouting(repositoryId);
  const save = useSetRepositoryReviewRouting(repositoryId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const data = routing.data;

  // Seed once per load of the stored override; a later refetch must not clobber an edit in progress.
  const stored = data ? JSON.stringify(data.override) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stored` is the serialised override
  useEffect(() => {
    if (data) {
      setDraft(toDraft(data.override));
    }
  }, [stored]);

  if (routing.isLoading) {
    return null;
  }
  const effective = data?.effective;
  const set = (patch: Partial<Draft>) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  return (
    <div className="space-y-3 rounded-lg border border-ink-600 p-3">
      <h4 className="text-sm text-paper-200">Review routing</h4>
      <p className="text-xs text-paper-500">
        Which open pull requests ask for a person. A repository can only ask for a person more often
        than its team and organization settings do; a blank field inherits the value in force.
      </p>
      {routing.isError && (
        <Alert variant="error">
          {errMsg(routing.error, 'The review routing could not be read')}
        </Alert>
      )}
      {draft && effective && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setSaved(false);
            const override = toOverride(draft);
            save.mutate(Object.keys(override).length > 0 ? override : null, {
              onError: (err) => setError(errMsg(err, 'The review routing could not be saved')),
              onSuccess: () => setSaved(true),
            });
          }}
        >
          <Select
            disabled={disabled}
            hint="Always ask for a person at or above this risk class."
            label="Minimum risk that asks for a person"
            onChange={(v) => set({ humanMinRisk: v })}
            options={[
              { label: `Inherit (${RISK_LABEL[effective.humanMinRisk]})`, value: '' },
              { label: 'Low', value: 'LOW' },
              { label: 'Standard', value: 'STANDARD' },
              { label: 'High', value: 'HIGH' },
            ]}
            value={draft.humanMinRisk}
          />
          <Input
            disabled={disabled}
            hint={`Always ask for a person above this many changed lines; 0 turns the size rule off. In force: ${effective.humanAboveLines}.`}
            label="Ask above (lines)"
            min={0}
            onChange={(e) => set({ humanAboveLines: e.target.value })}
            placeholder="Inherit"
            type="number"
            value={draft.humanAboveLines}
          />
          <Textarea
            compact
            disabled={disabled}
            hint={`One glob per line, from the repository root (for example db/migrations/**). A change touching a match always asks for a person. In force: ${
              effective.humanPaths.length > 0 ? effective.humanPaths.join(', ') : 'none'
            }.`}
            label="Paths that always ask for a person"
            onChange={(e) => set({ humanPaths: e.target.value })}
            rows={3}
            spellCheck={false}
            value={draft.humanPaths}
          />
          <Input
            disabled={disabled}
            hint={`A low-risk change of at most this many lines is a quick review. In force: ${effective.quickReviewMaxLines}.`}
            label="Quick review up to (lines)"
            min={0}
            onChange={(e) => set({ quickReviewMaxLines: e.target.value })}
            placeholder="Inherit"
            type="number"
            value={draft.quickReviewMaxLines}
          />
          <Select
            disabled={disabled}
            hint="A pull request the approver App approved, with auto-merge armed, asks for no person unless another rule fires."
            label="Bot-approved pull requests"
            onChange={(v) => set({ skipWhenBotApproved: v })}
            options={[
              {
                label: `Inherit (${effective.skipWhenBotApproved ? 'skip a person' : 'ask a person'})`,
                value: '',
              },
              { label: 'Still ask a person', value: 'false' },
            ]}
            value={draft.skipWhenBotApproved === 'true' ? '' : draft.skipWhenBotApproved}
          />
          {error && <Alert variant="error">{error}</Alert>}
          {saved && <Alert variant="success">Review routing saved.</Alert>}
          <div className="flex items-center gap-2">
            <Button disabled={disabled || save.isPending} size="sm" type="submit">
              {save.isPending ? 'Saving…' : 'Save review routing'}
            </Button>
            <Button
              disabled={disabled || save.isPending}
              onClick={() => set(toDraft({}))}
              size="sm"
              type="button"
              variant="ghost"
            >
              Clear override
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
