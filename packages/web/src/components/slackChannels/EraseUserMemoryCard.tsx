'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { useEraseSlackUserMemory } from '@/hooks/useSlackChannels';
import { plural } from '@/lib/utils';

/** A Slack member id: `U…` for a user, `W…` for an Enterprise Grid user. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * Forgets everything the assistant remembers from one person's turns, in every channel. For a
 * person's request to be forgotten: it cannot be undone, and the audit row records how much went,
 * never what.
 */
export function EraseUserMemoryCard() {
  const [slackUserId, setSlackUserId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const erase = useEraseSlackUserMemory();
  const id = slackUserId.trim();
  const valid = SLACK_USER_ID.test(id);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Erase a user's channel memory</CardTitle>
      </CardHeader>
      <p className="mb-4 max-w-3xl text-sm text-paper-400">
        Forgets every channel memory written from one Slack user's turns, in every channel, along
        with everything merged from them. Use it when a person asks to be forgotten.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72">
          <Input
            autoComplete="off"
            className="font-mono"
            error={
              id && !valid ? 'A Slack member id starts with U or W, e.g. U01ABC23DEF' : undefined
            }
            id="erase-user-slack-id"
            label="Slack user id"
            onChange={(e) => {
              setSlackUserId(e.target.value);
              setOutcome(null);
            }}
            placeholder="U01ABC23DEF"
            value={slackUserId}
          />
        </div>
        <Button
          disabled={!valid}
          onClick={() => setConfirming(true)}
          type="button"
          variant="danger"
        >
          Erase memory
        </Button>
      </div>
      {outcome && (
        <div className="mt-4">
          <Alert variant="success">{outcome}</Alert>
        </div>
      )}
      <ConfirmModal
        confirmLabel="Erase memory"
        confirmText={id}
        dangerous
        message={
          <>
            Permanently forgets every channel memory written from <strong>{id}</strong>'s turns, in
            every channel, including anything merged from them. This cannot be undone.
          </>
        }
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          const r = await erase.mutateAsync(id);
          setOutcome(
            `Forgot ${plural(r.forgotten, 'memory item')} written by ${id}${
              r.restored > 0 ? `; ${plural(r.restored, 'item')} restored` : ''
            }.`
          );
          setSlackUserId('');
        }}
        open={confirming}
        pendingLabel="Erasing…"
        title="Erase this user's channel memory?"
      />
    </Card>
  );
}
