'use client';

import { memo, type ReactNode, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { intraLineDiff, type Segment } from '@/lib/intraLineDiff';
import { cn, FOCUS_RING } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import type { ParsedDiffLine } from '../approvals/diffParse';
import { type DiffCell, type DiffRow, pairSideBySide } from './diffRows';

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

/** The mark on the words an edit changed; the line's own colour shows through the rest. */
const CHANGED_CLASS = {
  add: 'rounded-sm bg-success-400/30 text-inherit',
  del: 'rounded-sm bg-danger-400/30 text-inherit',
} as const;

/** The left edge of a line that was moved rather than written, and its name for a screen reader. */
const MOVED_CLASS = 'border-l-2 border-info-400';

/**
 * A line's text. With `segments`, the words the edit changed are marked and the rest is plain. It is
 * repository text either way: invisible and direction-changing characters are made visible, and it is
 * never markup. A tab is layout, so `multiline` keeps it.
 */
function LineText({
  kind,
  segments,
  text,
}: {
  kind: 'add' | 'del' | 'plain';
  segments: readonly Segment[] | undefined;
  text: string;
}) {
  if (segments === undefined || kind === 'plain') {
    return <>{visibleText(text, { multiline: true }) || ' '}</>;
  }
  return (
    <>
      {segments.map((segment, i) =>
        segment.changed ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <mark className={CHANGED_CLASS[kind]} key={i}>
            {visibleText(segment.text, { multiline: true })}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <span key={i}>{visibleText(segment.text, { multiline: true })}</span>
        )
      )}
    </>
  );
}

function DiffLine({
  id,
  line,
  moved = false,
  segments,
}: {
  id: string | undefined;
  line: ParsedDiffLine;
  moved?: boolean;
  segments?: readonly Segment[] | undefined;
}) {
  const marked = segments !== undefined && (line.kind === 'add' || line.kind === 'del');
  return (
    <div className={cn('flex', LINE_CLASS[line.kind], moved && MOVED_CLASS)} id={id}>
      {moved ? <span className="sr-only">Moved: </span> : null}
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
      <span className="whitespace-pre px-2">
        {marked ? (
          <>
            {/* The patch's `+` or `-`, kept out of the words so it is never marked as changed. */}
            {line.text.slice(0, 1)}
            <LineText
              kind={line.kind as 'add' | 'del'}
              segments={segments}
              text={line.text.slice(1)}
            />
          </>
        ) : (
          <LineText kind="plain" segments={undefined} text={line.text} />
        )}
      </span>
    </div>
  );
}

/** One side of a split row. An empty side is drawn as a plain, quiet block. */
function SplitCell({
  borderRight,
  cell,
  id,
  moved,
  segments,
}: {
  borderRight: boolean;
  cell: DiffCell | null;
  id: string | undefined;
  moved: boolean;
  segments: readonly Segment[] | undefined;
}) {
  if (cell === null) {
    return (
      <div
        aria-hidden="true"
        className={cn('bg-ink-900/40', borderRight && 'border-r border-ink-600/60')}
      />
    );
  }
  return (
    <div
      className={cn(
        'flex min-w-0',
        LINE_CLASS[cell.kind],
        borderRight && 'border-r border-ink-600/60',
        moved && MOVED_CLASS
      )}
      id={id}
    >
      {moved ? <span className="sr-only">Moved: </span> : null}
      <span
        aria-hidden="true"
        className="tabular w-10 shrink-0 select-none border-r border-ink-600/60 pr-2 text-right text-paper-600"
      >
        {cell.no ?? ''}
      </span>
      {/* Wrapped, not scrolled: two panes that scrolled sideways on their own would drift apart. */}
      <span className="min-w-0 whitespace-pre-wrap break-words px-2">
        <LineText
          kind={cell.kind === 'ctx' ? 'plain' : cell.kind}
          segments={segments}
          text={cell.text}
        />
      </span>
    </div>
  );
}

function SplitRow({
  anchorId,
  annotations,
  edits,
  moved,
  row,
}: {
  anchorId: string | undefined;
  annotations: ReadonlyMap<number, ReactNode> | undefined;
  edits: ReadonlyMap<number, readonly Segment[]> | null;
  moved: ReadonlySet<number> | undefined;
  row: DiffRow;
}) {
  if (row.type === 'full') {
    return <DiffLine id={undefined} line={row.line} />;
  }
  // Notes and links belong to the new side: a removed line has no place there to hang one.
  const newNo = row.right?.no ?? null;
  const note = newNo !== null ? annotations?.get(newNo) : undefined;
  const lineId = anchorId !== undefined && newNo !== null ? diffLineId(anchorId, newNo) : undefined;
  return (
    <div>
      <div className="grid grid-cols-2">
        <SplitCell
          borderRight
          cell={row.left}
          id={undefined}
          moved={row.left?.kind === 'del' && moved?.has(row.left.index) === true}
          segments={row.left ? edits?.get(row.left.index) : undefined}
        />
        <SplitCell
          borderRight={false}
          cell={row.right}
          id={lineId}
          moved={row.right?.kind === 'add' && moved?.has(row.right.index) === true}
          segments={row.right ? edits?.get(row.right.index) : undefined}
        />
      </div>
      {note !== undefined ? (
        <div className="border-y border-ink-600/60 bg-ink-900 px-3 py-2 font-sans">{note}</div>
      ) : null}
    </div>
  );
}

/** How a file's lines are laid out: one column as the patch has them, or old beside new. */
export type DiffMode = 'unified' | 'split';

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
  /** Unified (the default) or split, old beside new. */
  mode?: DiffMode;
  /**
   * The indexes, in `lines`, of the removed and added lines that are part of a block moved from or
   * to somewhere else in the change. They are marked, not otherwise changed. Keep it stable.
   */
  moved?: ReadonlySet<number> | undefined;
};

/**
 * The changed words of each edited line pair that is about to be drawn, by the index of the line.
 * Only pairs within `upTo` lines are compared: a file asked to draw its first screenful does not
 * pay to compare the rest of a large rewrite.
 */
function wordEdits(rows: readonly DiffRow[], upTo: number): Map<number, readonly Segment[]> {
  const edits = new Map<number, readonly Segment[]>();
  for (const row of rows) {
    if (row.type !== 'pair' || row.left?.kind !== 'del' || row.right?.kind !== 'add') {
      continue;
    }
    if (row.right.index >= upTo) {
      break;
    }
    const diff = intraLineDiff(row.left.text, row.right.text);
    if (diff) {
      edits.set(row.left.index, diff.removed);
      edits.set(row.right.index, diff.added);
    }
  }
  return edits;
}

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
  mode = 'unified',
  moved,
  name,
  onToggle,
  open,
  previousName,
  removed,
  rowLimit = DEFAULT_ROW_LIMIT,
}: DiffFileProps) {
  const [limit, setLimit] = useState(rowLimit);
  // Paired only while the file is open: a closed file draws, and so computes, nothing. Both layouts
  // read the pairs, the split one to draw them and the unified one to find the edited words.
  const paired = useMemo(() => (open ? pairSideBySide(lines) : null), [lines, open]);
  const edits = useMemo(() => (paired ? wordEdits(paired, limit * 2) : null), [paired, limit]);
  const rows = mode === 'split' ? paired : null;
  const total = rows ? rows.length : lines.length;
  const shown = open ? lines.slice(0, limit) : [];
  const shownRows = rows ? rows.slice(0, limit) : [];
  const hidden = open ? total - (rows ? shownRows.length : shown.length) : 0;
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
          <div className={cn('py-1', rows ? 'w-full' : 'w-max min-w-full')}>
            {rows
              ? shownRows.map((row, n) => (
                  <SplitRow
                    anchorId={anchorId}
                    annotations={annotations}
                    edits={edits}
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff rows are positional
                    key={n}
                    moved={moved}
                    row={row}
                  />
                ))
              : shown.map((line, n) => {
                  const note = line.newNo !== null ? annotations?.get(line.newNo) : undefined;
                  const lineId =
                    anchorId !== undefined && line.newNo !== null && line.kind !== 'del'
                      ? diffLineId(anchorId, line.newNo)
                      : undefined;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                    <div key={n}>
                      <DiffLine
                        id={lineId}
                        line={line}
                        moved={moved?.has(n) === true && line.kind !== 'ctx'}
                        segments={edits?.get(n)}
                      />
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
              <span className="text-paper-400">
                {hidden} more {rows ? 'rows' : 'lines'} not drawn.
              </span>
              <Button onClick={() => setLimit((l) => l + rowLimit)} size="sm" variant="ghost">
                Show more
              </Button>
              <Button onClick={() => setLimit(total)} size="sm" variant="ghost">
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
