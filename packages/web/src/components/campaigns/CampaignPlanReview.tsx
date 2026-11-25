'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Textarea } from '@/components/ui/Textarea';
import {
  type CampaignDetail,
  useConfirmCampaign,
  useEditCampaignTarget,
} from '@/hooks/useCampaigns';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { GATE_LABELS, targetAnchor } from './campaignDisplay';
import { UpstreamNames } from './UpstreamNames';

/** The gateway's limit on one brief. */
export const BRIEF_MAX_LENGTH = 8000;
const CONFIRM_BLOCKED_ID = 'campaign-plan-confirm-blocked';

/** What the gateway's `CAMPAIGN_PLAN_NOT_READY` refusal means to the person who pressed Confirm. */
export const PLAN_NOT_READY_MESSAGE =
  'The plan is not ready: at least one repository has no brief yet. Wait for the planner to finish, or cancel this campaign and start it again.';

/**
 * What the planner decided, shown to the launcher before anything starts: one brief per
 * repository and the order between them. Confirming starts the campaign. The launcher may rewrite
 * a brief and change which repositories one starts after before confirming (the gateway checks the
 * order and answers a cycle with a refusal shown beside the form); after a planning failure that
 * is how the briefs get written. Anyone else sees the plan read-only.
 */
export function CampaignPlanReview({
  campaign,
  isLauncher,
}: {
  campaign: Pick<CampaignDetail, 'gate' | 'id' | 'planFailure' | 'targets'>;
  /** Only the launcher may confirm (the gateway decides). */
  isLauncher: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const confirm = useConfirmCampaign(campaign.id);
  const targets = [...campaign.targets].sort((a, b) => a.position - b.position);
  const labels = new Map(targets.map((t) => [t.id, t.repoLabel]));
  const planFailed = campaign.planFailure !== null && campaign.planFailure !== undefined;
  const missingBriefs = targets.filter((t) => !t.brief?.trim()).length;
  const blockedReason =
    targets.length === 0
      ? planFailed
        ? 'Planning failed and there is no planned work to confirm. Cancel this campaign and start a new one.'
        : 'There is no planned work to confirm yet.'
      : missingBriefs > 0
        ? `${missingBriefs} ${missingBriefs === 1 ? 'repository has' : 'repositories have'} no brief yet, so the plan cannot be confirmed.${isLauncher ? ' Edit each one to write its brief.' : ''}`
        : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle hint="The planner’s work for each repository. Nothing starts until the launcher confirms.">
          Plan
        </CardTitle>
        <span className="text-sm text-paper-400">
          A repository starts when {GATE_LABELS[campaign.gate].toLowerCase()}
        </span>
      </CardHeader>
      {campaign.planFailure && (
        <Alert className="mb-4" title="Planning failed" variant="error">
          Planning failed: {campaign.planFailure.reason}
          {isLauncher
            ? ' You can write each repository’s brief yourself with Edit, then confirm.'
            : ' The person who started this campaign can write the briefs by hand and confirm.'}
        </Alert>
      )}
      {targets.length === 0 ? (
        <EmptyState
          hint="The planner has not written any work yet. Check again in a moment."
          icon="clock"
          title="No planned work to show"
        />
      ) : (
        <ol className="space-y-3">
          {targets.map((target) => (
            <li
              className="rounded-lg border border-ink-500/70 bg-ink-900/40 p-3"
              id={targetAnchor(target.id)}
              key={target.id}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="break-words text-sm font-medium text-paper-100">{target.repoLabel}</p>
                {isLauncher && editingId !== target.id && (
                  <Button
                    aria-label={`Edit ${target.repoLabel}`}
                    onClick={() => setEditingId(target.id)}
                    size="sm"
                  >
                    Edit
                  </Button>
                )}
              </div>
              {editingId === target.id ? (
                <TargetEditor
                  campaignId={campaign.id}
                  onDone={() => setEditingId(null)}
                  others={targets.filter((t) => t.id !== target.id)}
                  target={target}
                />
              ) : (
                <>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-paper-300">
                    {target.brief || (
                      <span className="text-paper-500">No brief for this repository</span>
                    )}
                  </p>
                  <p className="mt-2 text-xs text-paper-500">
                    {target.dependsOn.length > 0 ? (
                      <>
                        Starts after{' '}
                        <UpstreamNames labels={labels} linkable targetIds={target.dependsOn} />
                      </>
                    ) : (
                      'Starts first: it waits for no other repository'
                    )}
                  </p>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {isLauncher ? (
          <Button
            aria-describedby={blockedReason ? CONFIRM_BLOCKED_ID : undefined}
            disabled={blockedReason !== null}
            onClick={() => {
              setRefusal(null);
              setOpen(true);
            }}
            variant="primary"
          >
            Confirm and start
          </Button>
        ) : (
          <p className="text-sm text-paper-400">
            Only the person who started this campaign can confirm it.
          </p>
        )}
      </div>
      {isLauncher && blockedReason && (
        <p className="mt-2 text-sm text-warning-400" id={CONFIRM_BLOCKED_ID}>
          {blockedReason}
        </p>
      )}
      {refusal && (
        <p className="mt-2 text-sm text-danger-400" role="alert">
          {refusal}
        </p>
      )}
      {isLauncher && (
        <p className="mt-2 text-xs text-paper-500">
          Use Edit on a repository to change its brief or the repositories it starts after before
          confirming.
        </p>
      )}
      <ConfirmModal
        confirmLabel="Confirm and start"
        message={
          <p>
            The campaign starts now. Repositories begin in the order above, and every pull request
            is opened as you.
          </p>
        }
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          try {
            await confirm.mutateAsync();
          } catch (err) {
            if (err instanceof ApiError && err.code === 'CAMPAIGN_PLAN_NOT_READY') {
              setRefusal(PLAN_NOT_READY_MESSAGE);
              return;
            }
            throw err;
          }
        }}
        open={open}
        pendingLabel="Starting…"
        title="Start this campaign?"
      />
    </Card>
  );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * The form for one target: its brief (1 to 8000 characters) and the other repositories it starts
 * after. Only what changed is sent. The gateway's refusal (a cycle, an unknown repository, a
 * campaign no longer being planned) shows beside the buttons as text and the form stays open.
 */
function TargetEditor({
  campaignId,
  onDone,
  others,
  target,
}: {
  campaignId: string;
  onDone: () => void;
  others: CampaignDetail['targets'];
  target: CampaignDetail['targets'][number];
}) {
  const edit = useEditCampaignTarget(campaignId);
  const [brief, setBrief] = useState(target.brief ?? '');
  const [dependsOn, setDependsOn] = useState<string[]>(target.dependsOn);
  const [error, setError] = useState<string | null>(null);
  const trimmed = brief.trim();
  const briefChanged = trimmed !== (target.brief ?? '').trim();
  const edgesChanged = !sameSet(dependsOn, target.dependsOn);
  const tooLong = brief.length > BRIEF_MAX_LENGTH;
  const valid = trimmed.length > 0 && !tooLong;
  const toggle = (id: string, on: boolean) =>
    setDependsOn((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
  return (
    <form
      aria-label={`Edit ${target.repoLabel}`}
      className="mt-2 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await edit.mutateAsync({
            body: {
              ...(briefChanged ? { brief: trimmed } : {}),
              ...(edgesChanged ? { dependsOn } : {}),
            },
            targetId: target.id,
          });
          onDone();
        } catch (err) {
          setError(errMsg(err, 'The change could not be saved'));
        }
      }}
    >
      <Textarea
        compact
        error={tooLong ? `A brief is at most ${BRIEF_MAX_LENGTH} characters.` : undefined}
        hint={`${brief.length} / ${BRIEF_MAX_LENGTH} characters`}
        label="Brief"
        mono={false}
        onChange={(e) => setBrief(e.target.value)}
        rows={6}
        value={brief}
      />
      {others.length > 0 && (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-paper-300">Starts after</legend>
          {others.map((other) => (
            <Checkbox
              checked={dependsOn.includes(other.id)}
              key={other.id}
              label={other.repoLabel}
              onChange={(e) => toggle(other.id, e.target.checked)}
            />
          ))}
        </fieldset>
      )}
      {error && (
        <p className="text-sm text-danger-400" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          disabled={!valid || (!briefChanged && !edgesChanged) || edit.isPending}
          size="sm"
          type="submit"
          variant="primary"
        >
          {edit.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button disabled={edit.isPending} onClick={onDone} size="sm" type="button">
          Cancel
        </Button>
      </div>
    </form>
  );
}
