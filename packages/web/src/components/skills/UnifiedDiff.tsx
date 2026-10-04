import { cn } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

type Kind = 'add' | 'del' | 'hunk' | 'ctx';

const kindOf = (line: string): Kind =>
  line.startsWith('@@')
    ? 'hunk'
    : line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'del'
        : 'ctx';

const KIND_CLASS: Record<Kind, string> = {
  add: 'bg-moss-400/10 text-moss-400',
  ctx: 'text-paper-300',
  del: 'bg-brick-400/10 text-brick-400',
  hunk: 'text-dust-400',
};

/**
 * A unified diff with additions and removals coloured. Every line is plain text
 * (never HTML) and has its invisible and direction-changing characters shown,
 * so a reordered or hidden line cannot read differently from what is stored.
 */
export function UnifiedDiff({ text }: { text: string }) {
  // A diff's lines repeat and never reorder, so their position is their identity.
  const lines = text.split('\n').map((line, id) => ({ id, kind: kindOf(line), line }));
  return (
    <section
      aria-label="Text diff"
      className="max-h-96 overflow-auto rounded-[9px] border border-ink-600 bg-ink-900 py-2 font-mono text-xs"
    >
      {lines.map(({ id, kind, line }) => (
        <div
          className={cn('whitespace-pre-wrap break-words px-3', KIND_CLASS[kind])}
          data-kind={kind}
          key={id}
        >
          {visibleText(line, { multiline: true }) || ' '}
        </div>
      ))}
    </section>
  );
}
