'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * "Try a sample task" for a launch form. It fills fields through `onFill` and nothing else: it
 * never launches, and it is disabled while `blocked` (the form holds text the user typed), so a
 * sample cannot overwrite their work. The reason is on screen, not in a tooltip or a dialog.
 */
export function SampleTaskButton({
  blocked,
  caption,
  onFill,
}: {
  /** The form already holds user input; filling would replace it. */
  blocked: boolean;
  /** What the sample fills in, and what the user still has to choose. */
  caption: string;
  onFill: () => void;
}) {
  const [filled, setFilled] = useState(false);
  const captionId = useId();
  // Once the fields are clear again the next fill is a fresh one, so the caption must not keep
  // claiming a sample is loaded.
  useEffect(() => {
    if (!blocked) {
      setFilled(false);
    }
  }, [blocked]);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-ink-500/70 p-3 sm:flex-row sm:items-center">
      <Button
        aria-describedby={captionId}
        disabled={blocked}
        onClick={() => {
          onFill();
          setFilled(true);
        }}
        size="sm"
        variant="secondary"
      >
        Try a sample task
      </Button>
      <p className="min-w-0 text-sm leading-relaxed text-paper-500" id={captionId}>
        {blocked
          ? filled
            ? 'Sample filled in. Edit it freely; nothing runs until you review and launch.'
            : 'Clear the fields you have filled in to load a sample.'
          : caption}
      </p>
    </div>
  );
}
