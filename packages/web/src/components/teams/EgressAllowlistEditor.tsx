'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { useTeamEgressAllowlist, useUpdateTeamEgressAllowlist } from '@/hooks/useTeams';
import { useTransientFlag } from '@/hooks/useTransientFlag';
import { errMsg } from '@/lib/errors';

export function EgressAllowlistEditor({ teamId }: { teamId: string }) {
  const { data, isLoading } = useTeamEgressAllowlist(teamId);
  const update = useUpdateTeamEgressAllowlist(teamId);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, markSaved, resetSaved] = useTransientFlag();
  // true while the user has unsaved edits; prevents server refetch from overwriting the textarea
  const isDirtyRef = useRef(false);

  useEffect(() => {
    if (data && !isDirtyRef.current) {
      setText(data.egressAllowlist.join('\n'));
    }
  }, [data]);

  async function handleSave() {
    setError(null);
    resetSaved();
    const list = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await update.mutateAsync(list);
      isDirtyRef.current = false;
      markSaved();
    } catch (err) {
      setError(errMsg(err, 'Failed to update allowlist'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="security · per team">Egress hostname allowlist</CardTitle>
      </CardHeader>
      <p className="mb-3 text-xs text-paper-500">
        Shell steps with <code className="text-paper-300">network: egress</code> may only reach
        these hostnames via DNS. One hostname per line, e.g.{' '}
        <code className="text-paper-300">registry.npmjs.org</code> or{' '}
        <code className="text-paper-300">*.github.com</code>. Wildcard entries are informational
        only — DNS filtering applies to exact lookups; IP-direct connections are not blocked.
      </p>
      {isLoading ? (
        <LoadingState compact />
      ) : (
        <>
          <textarea
            className="min-h-[120px] w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 font-mono text-xs text-paper-100 outline-none transition-colors focus:border-ember-400"
            onChange={(e) => {
              isDirtyRef.current = true;
              setText(e.target.value);
            }}
            placeholder="registry.npmjs.org"
            value={text}
          />
          <div className="mt-3 flex items-center justify-between">
            {error ? (
              <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">
                {error}
              </p>
            ) : saved ? (
              <p className="font-mono text-[10px] uppercase tracking-wider text-moss-400">
                ✓ saved
              </p>
            ) : (
              <span />
            )}
            <Button disabled={update.isPending} onClick={handleSave} size="sm" variant="primary">
              {update.isPending ? 'Saving…' : 'Save allowlist'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
