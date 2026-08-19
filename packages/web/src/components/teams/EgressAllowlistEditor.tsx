'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useTeamEgressAllowlist, useUpdateTeamEgressAllowlist } from '@/hooks/useWorkflows';
import { errMsg } from '@/lib/errors';

export function EgressAllowlistEditor({ teamId }: { teamId: string }) {
  const { data, isLoading } = useTeamEgressAllowlist(teamId);
  const update = useUpdateTeamEgressAllowlist(teamId);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // true while the user has unsaved edits; prevents server refetch from overwriting the textarea
  const isDirtyRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (data && !isDirtyRef.current) {
      setText(data.egressAllowlist.join('\n'));
    }
  }, [data]);

  useEffect(
    () => () => {
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
      }
    },
    []
  );

  async function handleSave() {
    setError(null);
    setSaved(false);
    const list = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await update.mutateAsync(list);
      isDirtyRef.current = false;
      setSaved(true);
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = setTimeout(() => setSaved(false), 1500);
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
        <p className="text-xs text-paper-500">Loading…</p>
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
