'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import { useTransientFlag } from '@/hooks/useTransientFlag';
import { errMsg } from '@/lib/errors';

/**
 * One-entry-per-line textarea editor for a team allowlist. The data hook and
 * mutation stay with the caller (shell images, egress hostnames); this owns
 * the textarea, the dirty guard and the save / saved / error strip.
 */
export function AllowlistEditor({
  description,
  eyebrow = 'security · per team',
  isLoading,
  items,
  onSave,
  placeholder,
  saving,
  title,
}: {
  description: ReactNode;
  eyebrow?: string;
  isLoading: boolean;
  /** Current server value; undefined while loading. */
  items: string[] | undefined;
  onSave: (list: string[]) => Promise<unknown>;
  placeholder: string;
  saving: boolean;
  title: string;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, markSaved, resetSaved] = useTransientFlag();
  // True once the admin has typed. Without this, a background refetch that
  // returns genuinely different data (a second admin, a second tab) replaces
  // the textarea mid-edit.
  const isDirtyRef = useRef(false);

  useEffect(() => {
    if (items && !isDirtyRef.current) {
      setText(items.join('\n'));
    }
  }, [items]);

  async function handleSave() {
    setError(null);
    resetSaved();
    const list = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await onSave(list);
      isDirtyRef.current = false;
      markSaved();
    } catch (err) {
      setError(errMsg(err, 'Failed to update allowlist'));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow={eyebrow}>{title}</CardTitle>
      </CardHeader>
      <p className="mb-3 text-xs text-paper-500">{description}</p>
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
            placeholder={placeholder}
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
            <Button disabled={saving} onClick={handleSave} size="sm" variant="primary">
              {saving ? 'Saving…' : 'Save allowlist'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
