'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Textarea } from '@/components/ui/Textarea';
import { useTransientFlag } from '@/hooks/useTransientFlag';
import { errMsg } from '@/lib/errors';

/**
 * One-entry-per-line textarea editor for a team allowlist. The data hook and
 * mutation stay with the caller (shell images, egress hostnames); this owns
 * the textarea, the dirty guard and the save / saved / error strip.
 */
export function AllowlistEditor({
  description,
  eyebrow = 'Sandbox',
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
    <Card className="flex flex-col">
      <CardHeader className="mb-1">
        <CardTitle eyebrow={eyebrow}>{title}</CardTitle>
        {items && (
          <span className="text-xs text-paper-500 tabular-nums">
            {items.length === 0
              ? 'Empty'
              : `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`}
          </span>
        )}
      </CardHeader>
      <p className="mb-4 text-[13px] leading-relaxed text-paper-400">{description}</p>
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          <Textarea
            aria-label={title}
            className="min-h-[140px] font-mono text-[13px]"
            onChange={(e) => {
              isDirtyRef.current = true;
              setText(e.target.value);
            }}
            placeholder={placeholder}
            value={text}
          />
          <p className="mt-1.5 text-xs text-paper-500">One entry per line.</p>
          <div className="mt-auto flex flex-wrap items-center justify-end gap-3 pt-4">
            {error ? (
              <Alert className="flex-1">{error}</Alert>
            ) : saved ? (
              <Alert className="flex-1" variant="success">
                Saved
              </Alert>
            ) : null}
            <Button disabled={saving} onClick={handleSave} variant="secondary">
              {saving ? 'Saving…' : 'Save allowlist'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
