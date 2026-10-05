import { memo, useMemo } from 'react';
import { visibleText } from '@/lib/visibleText';

/** A skill's complete text (up to 50 000 characters) in a scrollable panel, made visible once per text. */
export const FullText = memo(function FullText({ label, text }: { label: string; text: string }) {
  const shown = useMemo(() => visibleText(text, { multiline: true }), [text]);
  return (
    <section
      aria-label={label}
      className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-ink-600 bg-ink-900 p-3 font-mono text-xs text-paper-200"
    >
      {shown}
    </section>
  );
});
