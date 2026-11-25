'use client';

import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import {
  type CampaignDetail,
  usePauseCampaign,
  useResumeCampaign,
  useTakeOverCampaign,
} from '@/hooks/useCampaigns';
import { useAuthStore } from '@/stores/authStore';
import { PAUSED_REASON_LABELS } from './campaignDisplay';

type Kind = 'pause' | 'resume' | 'takeover';

/**
 * Pause, resume and take over, each behind a confirmation that says what it does. The page decides
 * who is shown them (the creator, a lead of the owning team or an administrator; a take-over never
 * the current launcher) and the gateway still decides: its refusal appears in the dialog.
 */
export function CampaignActions({
  campaign,
  canManage,
  canTakeOver,
}: {
  campaign: Pick<CampaignDetail, 'id' | 'pausedReason' | 'state'>;
  /** The caller may pause and resume. */
  canManage: boolean;
  /** The caller may take the campaign over: a lead of the owning team or an administrator, not the launcher. */
  canTakeOver: boolean;
}) {
  const [kind, setKind] = useState<Kind | null>(null);
  const email = useAuthStore((s) => s.user?.email);
  const pause = usePauseCampaign(campaign.id);
  const resume = useResumeCampaign(campaign.id);
  const takeOver = useTakeOverCampaign(campaign.id);
  const { pausedReason, state } = campaign;

  const showPause = canManage && (state === 'ACTIVE' || state === 'MONITORING');
  const showResume = canManage && state === 'PAUSED';
  const showTakeOver =
    canTakeOver && (state === 'ACTIVE' || state === 'MONITORING' || state === 'PAUSED');
  if (!showPause && !showResume && !showTakeOver) {
    return null;
  }

  const dialogs: Record<
    Kind,
    {
      confirmLabel: string;
      message: ReactNode;
      pendingLabel: string;
      run: () => Promise<unknown>;
      title: string;
    }
  > = {
    pause: {
      confirmLabel: 'Pause campaign',
      message: (
        <p>
          No repository will start while the campaign is paused. Runs already in flight finish, and
          the campaign stops re-checking until someone resumes it.
        </p>
      ),
      pendingLabel: 'Pausing…',
      run: () => pause.mutateAsync(),
      title: 'Pause this campaign?',
    },
    resume: {
      confirmLabel: 'Resume campaign',
      message: (
        <p>
          Repositories start again, and the campaign picks up where it stopped.
          {pausedReason
            ? ` It was paused because of: ${PAUSED_REASON_LABELS[pausedReason]}. If that still holds, the gateway refuses or the campaign pauses again.`
            : ''}
        </p>
      ),
      pendingLabel: 'Resuming…',
      run: () => resume.mutateAsync(),
      title: 'Resume this campaign?',
    },
    takeover: {
      confirmLabel: 'Take over campaign',
      message: (
        <div className="space-y-2">
          <p>
            From now on this campaign runs as <strong>you{email ? ` (${email})` : ''}</strong>. Pull
            requests it opens are opened as you, with your access.
          </p>
          <p>
            Every repository that has not finished is checked again against what you can reach.
            Repositories you cannot reach are skipped, with the reason recorded on each; the rest
            continue as you.
          </p>
          <p>
            Runs already in flight finish as before, and pull requests already opened stay as they
            are.
          </p>
        </div>
      ),
      pendingLabel: 'Taking over…',
      run: () => takeOver.mutateAsync(),
      title: 'Take over this campaign?',
    },
  };
  const dialog = kind ? dialogs[kind] : null;

  return (
    <>
      {showPause && <Button onClick={() => setKind('pause')}>Pause</Button>}
      {showResume && (
        <Button onClick={() => setKind('resume')} variant="primary">
          Resume
        </Button>
      )}
      {showTakeOver && <Button onClick={() => setKind('takeover')}>Take over</Button>}
      <ConfirmModal
        confirmLabel={dialog?.confirmLabel}
        message={dialog?.message}
        onClose={() => setKind(null)}
        onConfirm={async () => {
          await dialog?.run();
        }}
        open={dialog !== null}
        pendingLabel={dialog?.pendingLabel}
        title={dialog?.title ?? ''}
      />
    </>
  );
}
