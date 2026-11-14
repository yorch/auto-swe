'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { type ShellAuditPruneResult, useShellAuditPrune } from '@/hooks/useAdmin';
import { useHasRole } from '@/hooks/useHasRole';
import { errMsg } from '@/lib/errors';

const MAX_DAYS = 3650;

/**
 * Retention for shell-step audit rows. Only rows of archived templates go; those of active and
 * draft templates are kept because any of their versions can be promoted again. A preview counts
 * first, and the delete is confirmed. Renders nothing for a non-admin.
 */
export function ShellAuditPrune() {
  const isAdmin = useHasRole('ADMIN');
  const prune = useShellAuditPrune();
  const [days, setDays] = useState('90');
  const [preview, setPreview] = useState<ShellAuditPruneResult | null>(null);
  const [deleted, setDeleted] = useState<ShellAuditPruneResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!isAdmin) {
    return null;
  }

  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_DAYS;

  async function runPreview() {
    setError(null);
    setDeleted(null);
    setPreview(null);
    try {
      setPreview(await prune.mutateAsync({ days: n, dryRun: true }));
    } catch (err) {
      setError(errMsg(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shell audit retention</CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <p className="text-sm text-paper-400">
          Deletes shell-step audit rows older than the number of days below whose workflow template
          is archived. Rows of active and draft templates are always kept.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Input
            className="w-32"
            error={days !== '' && !valid ? `1 to ${MAX_DAYS}` : undefined}
            id="shell-audit-prune-days"
            inputMode="numeric"
            label="Older than (days)"
            onChange={(e) => {
              setDays(e.target.value);
              setPreview(null);
              setDeleted(null);
            }}
            value={days}
          />
          <Button
            disabled={!valid || prune.isPending}
            onClick={() => void runPreview()}
            type="button"
            variant="secondary"
          >
            Preview
          </Button>
          <Button
            disabled={!preview || preview.deleted === 0}
            onClick={() => setConfirming(true)}
            type="button"
            variant="danger"
          >
            Delete…
          </Button>
        </div>
        {error && <Alert>{error}</Alert>}
        {preview && (
          <p className="text-sm" data-testid="shell-audit-preview">
            {preview.deleted === 0
              ? `No rows are older than ${preview.olderThanDays} days on archived templates.`
              : `${preview.deleted} row${preview.deleted === 1 ? '' : 's'} older than ${preview.olderThanDays} days on archived templates would be deleted.`}
          </p>
        )}
        {deleted && (
          <Alert variant="success">
            Deleted {deleted.deleted} shell audit row{deleted.deleted === 1 ? '' : 's'}.
          </Alert>
        )}
      </div>
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={`Permanently deletes ${preview?.deleted ?? 0} shell audit rows older than ${preview?.olderThanDays ?? n} days that belong to archived templates. The records of who let that code run cannot be recovered.`}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          const result = await prune.mutateAsync({ days: n, dryRun: false });
          setDeleted(result);
          setPreview(null);
        }}
        open={confirming}
        pendingLabel="Deleting…"
        title="Delete shell audit rows?"
      />
    </Card>
  );
}
