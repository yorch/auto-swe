'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { SaveBar } from '@/components/ui/SaveBar';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useTransientFlag } from '@/hooks/useTransientFlag';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

/**
 * The pieces every Temporal-schedule config form shares (lesson consolidation,
 * eval re-validation): the enabled toggle with the live schedule status, and a
 * footer with the save / "Run now" actions and their result alerts.
 */

interface ScheduleStatus {
  exists: boolean;
  paused: boolean;
  nextRunAt: string | null;
}

export function ScheduleToggleRow({
  enabled,
  onToggle,
  schedule,
}: {
  enabled: boolean;
  onToggle: () => void;
  schedule: ScheduleStatus | undefined;
}) {
  return (
    <div className="flex items-center gap-3">
      <ToggleSwitch checked={enabled} label="Schedule enabled" onChange={onToggle} />
      {schedule?.exists && (
        <span className={`ml-auto text-xs ${schedule.paused ? 'text-paper-500' : 'text-moss-400'}`}>
          {schedule.paused
            ? 'Paused in Temporal'
            : schedule.nextRunAt
              ? `Next run: ${formatDate(schedule.nextRunAt)}`
              : 'Active in Temporal'}
        </span>
      )}
    </div>
  );
}

/** State for a schedule's on-demand "Run now" trigger. */
export function useRunNow(trigger: () => Promise<unknown>, failureMessage: string) {
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggered, markTriggered] = useTransientFlag();

  const run = async () => {
    setTriggering(true);
    setTriggerError(null);
    try {
      await trigger();
      markTriggered();
    } catch (err) {
      setTriggerError(errMsg(err, failureMessage));
    } finally {
      setTriggering(false);
    }
  };

  return { run, triggerError, triggered, triggering };
}

export function ScheduleFormFooter({
  canRun,
  dirtyCount,
  error,
  isSaving,
  onDiscard,
  runNow,
  saved,
  savedMessage,
  triggeredMessage,
}: {
  canRun: boolean;
  dirtyCount: number;
  error: string | null;
  isSaving: boolean;
  onDiscard: () => void;
  runNow: ReturnType<typeof useRunNow>;
  saved: boolean;
  savedMessage: string;
  triggeredMessage: string;
}) {
  return (
    <>
      {runNow.triggered && <Alert variant="success">{triggeredMessage}</Alert>}
      {runNow.triggerError && <Alert variant="error">{runNow.triggerError}</Alert>}

      <SaveBar
        dirtyCount={dirtyCount}
        error={error}
        onDiscard={onDiscard}
        pending={isSaving}
        saved={saved}
        savedMessage={savedMessage}
      >
        <Button
          disabled={runNow.triggering || !canRun}
          onClick={runNow.run}
          type="button"
          variant="secondary"
        >
          {runNow.triggering ? 'Triggering…' : 'Run now'}
        </Button>
      </SaveBar>
    </>
  );
}
