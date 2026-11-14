'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useCancelCampaign } from '@/hooks/useCampaigns';

/**
 * Cancels a campaign after confirmation. Repositories not yet started are never started,
 * in-flight runs are asked to stop, and draft pull requests already opened stay open. Shown only
 * to someone who may cancel (the gateway still decides, and its refusal appears in the dialog).
 */
export function CampaignCancel({
  campaignId,
  cancelling,
}: {
  campaignId: string;
  /** The cancel was already recorded; offering it again re-sends the signal. */
  cancelling: boolean;
}) {
  const [open, setOpen] = useState(false);
  const cancel = useCancelCampaign(campaignId);
  return (
    <>
      <Button onClick={() => setOpen(true)} variant="danger">
        {cancelling ? 'Send cancel again' : 'Cancel campaign'}
      </Button>
      <ConfirmModal
        confirmLabel="Cancel campaign"
        dangerous
        message={
          <p>
            Repositories that have not started will not start, and runs in flight are asked to stop.
            Draft pull requests already opened stay open for people to close.
          </p>
        }
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          await cancel.mutateAsync();
        }}
        open={open}
        pendingLabel="Cancelling…"
        title="Cancel this campaign?"
      />
    </>
  );
}
