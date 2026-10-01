'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
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
          <Textarea
            aria-label={title}
            className="min-h-[120px]"
            onChange={(e) => {
              isDirtyRef.current = true;
              setText(e.target.value);
            }}
            placeholder={placeholder}
            value={text}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            {error ? (
              <Alert>{error}</Alert>
            ) : saved ? (
              <Alert variant="success">Saved</Alert>
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
