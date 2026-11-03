'use client';

import { memo, type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cn, FOCUS_RING } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import type { ParsedDiffLine } from '../approvals/diffParse';

const LINE_CLASS: Record<ParsedDiffLine['kind'], string> = {
  add: 'bg-success-400/10 text-success-400',
  ctx: 'text-paper-300',
  del: 'bg-danger-400/10 text-danger-400',
  hunk: 'bg-info-400/[0.07] text-info-400',
  meta: 'text-paper-500',
};

/** Rows drawn before a file asks for more; a patch can run to hundreds of thousands of characters. */
export const DEFAULT_ROW_LIMIT = 1500;

/** The element id of a line of the new side of a file, for a link to land on. */
export function diffLineId(anchorId: string, newNo: number): string {
  return `${anchorId}-L${newNo}`;
}

function DiffLine({ id, line }: { id: string | undefined; line: ParsedDiffLine }) {
  return (
    <div className={cn('flex', LINE_CLASS[line.kind])} id={id}>
      <span
        aria-hidden="true"
        className="tabular w-10 shrink-0 select-none border-r border-ink-600/60 pr-2 text-right text-paper-600"
      >
        {line.oldNo ?? ''}
      </span>
      <span
        aria-hidden="true"
        className="tabular w-10 shrink-0 select-none border-r border-ink-600/60 pr-2 text-right text-paper-600"
      >
        {line.newNo ?? ''}
      </span>
      {/* Repository text: invisible and direction-changing characters are made visible, and the
          text is never markup. A tab is layout, so `multiline` keeps it. */}
      <span className="whitespace-pre px-2">
        {visibleText(line.text, { multiline: true }) || ' '}
      </span>
    </div>
  );
}

export type DiffFileProps = {
  /** Removed and added line counts, shown in the header. */
  added: number;
  removed: number;
  lines: readonly ParsedDiffLine[];
  name: string;
  /** Where a renamed file came from. */
  previousName?: string | null | undefined;
  /** Controlled: the caller owns whether the body is shown, so it can open or close many at once. */
  open: boolean;
  onToggle: () => void;
  /** Gives the section an id, and each line of the new side one (see {@link diffLineId}). */
  anchorId?: string | undefined;
  /** Drawn under the line of the new side with that number. Keep the map stable between renders. */
  annotations?: ReadonlyMap<number, ReactNode> | undefined;
  /** Shown beside the file name, outside the toggle (a viewed checkbox, a risk marker). */
  headerExtra?: ReactNode;
  /** Rows drawn before "Show more"; only an open file draws any. */
  rowLimit?: number;
};

/**
 * One file of a diff: a header that toggles the body, and the body's lines. A closed file draws no
 * rows, and an open one draws at most `rowLimit` until asked for more, so a large change costs
 * what is on screen and not what is in the patch.
 */
function DiffFileImpl({
  added,
  anchorId,
  annotations,
  headerExtra,
  lines,
  name,
  onToggle,
  open,
  previousName,
  removed,
  rowLimit = DEFAULT_ROW_LIMIT,
}: DiffFileProps) {
  const [limit, setLimit] = useState(rowLimit);
  const shown = open ? lines.slice(0, limit) : [];
  const hidden = open ? lines.length - shown.length : 0;
  return (
    <section
      className="overflow-hidden rounded-lg border border-ink-500/60 bg-ink-950/50"
      id={anchorId}
    >
      <div className="flex items-center bg-ink-800">
        <button
          aria-expanded={open}
          className={cn(
            FOCUS_RING,
            'flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-ink-700'
          )}
          onClick={onToggle}
          type="button"
        >
          <Icon
            className={cn('shrink-0 text-paper-500 transition-transform', open && 'rotate-90')}
            name="chevronRight"
            size={13}
          />
          <span className="min-w-0 flex-1 break-all font-mono text-paper-100">
            {previousName ? (
              <>
                <span className="text-paper-400">{visibleText(previousName)}</span>
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> renamed to </span>
              </>
            ) : null}
            {visibleText(name)}
          </span>
          <span className="tabular shrink-0 font-mono text-success-400">+{added}</span>
          <span className="tabular shrink-0 font-mono text-danger-400">−{removed}</span>
        </button>
        {headerExtra ? <div className="shrink-0 pr-3">{headerExtra}</div> : null}
      </div>
      {open && (
        <div className="overflow-x-auto border-t border-ink-600/60 font-mono text-xs leading-5">
          <div className="w-max min-w-full py-1">
            {shown.map((line, n) => {
              const note = line.newNo !== null ? annotations?.get(line.newNo) : undefined;
              const lineId =
                anchorId !== undefined && line.newNo !== null && line.kind !== 'del'
                  ? diffLineId(anchorId, line.newNo)
                  : undefined;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                <div key={n}>
                  <DiffLine id={lineId} line={line} />
                  {note !== undefined && line.kind !== 'del' ? (
                    <div className="border-y border-ink-600/60 bg-ink-900 px-3 py-2 font-sans">
                      {note}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {hidden > 0 && (
            <div className="flex items-center gap-2 border-t border-ink-600/60 px-3 py-2 font-sans">
              <span className="text-paper-400">{hidden} more lines not drawn.</span>
              <Button onClick={() => setLimit((l) => l + rowLimit)} size="sm" variant="ghost">
                Show more
              </Button>
              <Button onClick={() => setLimit(lines.length)} size="sm" variant="ghost">
                Show all
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export const DiffFile = memo(DiffFileImpl);
