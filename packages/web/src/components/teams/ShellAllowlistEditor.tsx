'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useTeamShellAllowlist, useUpdateTeamShellAllowlist } from '@/hooks/useWorkflows';
import { errMsg } from '@/lib/errors';

export function ShellAllowlistEditor({ teamId }: { teamId: string }) {
  const { data, isLoading } = useTeamShellAllowlist(teamId);
  const update = useUpdateTeamShellAllowlist(teamId);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // True once the admin has typed. Without this, a background refetch that
  // returns genuinely different data (a second admin, a second tab) replaces
  // the textarea mid-edit. Mirrors EgressAllowlistEditor.
  const isDirtyRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (data && !isDirtyRef.current) {
      setText(data.shellImageAllowlist.join('\n'));
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
        <CardTitle eyebrow="security · per team">Shell-step image allowlist</CardTitle>
      </CardHeader>
      <p className="mb-3 text-xs text-paper-500">
        Workflow shell steps may only use Docker images from this list (in addition to the team's
        repo executor images). One image per line, e.g.{' '}
        <code className="text-paper-300">ghcr.io/acme/ci-tools:latest</code>. Leave empty to
        disallow custom shell-step images entirely.
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
            placeholder="ghcr.io/acme/ci-tools:latest"
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
