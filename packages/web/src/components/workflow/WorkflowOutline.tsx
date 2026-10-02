'use client';

/**
 * WorkflowOutline — a workflow's steps as a list, in flow order, gathered by
 * `group`. The canvas answers "how is it wired"; this answers "what happens, in
 * what order", at any size, with a status beside each row and nothing to pan.
 *
 * Read-only and view-only: selecting a row only calls `onSelect`, exactly like
 * clicking a node on the canvas, so the same inspector, trace filter and diff
 * marks follow either. Used by the template page, the run viewer (with its
 * per-node status overlay) and the editor.
 *
 * Keyboard: the rows are buttons in one tab stop (roving tabindex). Up/Down move
 * to the previous/next row and select it, Home/End jump to the ends, Enter/Space
 * select the focused row, and a group heading is a button that folds its rows.
 */

import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/utils';
import type { DiffKind } from '@/lib/workflowLayout';
import { hasDisplayTitle, nodeDisplayName } from './nodeDisplay';
import { NODE_TYPE_TONE } from './nodeTypeTone';
import { buildOutline, nextOutlineId, type OutlineKey } from './outline';

interface Props {
  spec: WorkflowSpec;
  /** Per-node run status, from `buildDagOverlay` (fan-out aware). */
  statuses?: { byNodeId: Record<string, { status: string; attempt: number } | undefined> };
  diffMarkers?: Record<string, DiffKind>;
  selectedNodeId?: string | null;
  onSelect?: (id: string | null) => void;
  height?: number | string;
  className?: string;
}

/** Statuses a viewer is looking for: a group holding one is never folded. */
const ALWAYS_OPEN_STATUSES = new Set(['FAILED', 'RUNNING', 'PENDING']);

const STATUS_DOT: Record<string, string> = {
  FAILED: 'bg-brick-400',
  PASSED: 'bg-moss-400',
  PENDING: 'bg-amber-400',
  RUNNING: 'bg-dust-400',
  SKIPPED: 'bg-paper-500',
  SUCCESS: 'bg-moss-400',
};

const DIFF_TEXT: Record<DiffKind, string> = {
  added: 'text-moss-400',
  changed: 'text-amber-400',
  removed: 'text-brick-400',
};

const KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export function WorkflowOutline({
  spec,
  statuses,
  diffMarkers,
  selectedNodeId,
  onSelect,
  height,
  className,
}: Props) {
  const sections = useMemo(() => buildOutline(spec), [spec]);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const mustStayOpen = useCallback(
    (ids: readonly string[]): boolean =>
      ids.some((id) => {
        const status = statuses?.byNodeId[id]?.status;
        return (
          id === selectedNodeId ||
          (status !== undefined && ALWAYS_OPEN_STATUSES.has(status)) ||
          diffMarkers?.[id] !== undefined
        );
      }),
    [statuses, diffMarkers, selectedNodeId]
  );

  // Numbering is flow position across the whole spec, so a folded group's rows
  // leave a visible gap rather than renumbering the steps after it.
  const numbering = useMemo(() => {
    const out = new Map<string, number>();
    let n = 0;
    for (const section of sections) {
      for (const id of section.nodeIds) {
        out.set(id, ++n);
      }
    }
    return out;
  }, [sections]);

  const visibleIds = useMemo(
    () =>
      sections.flatMap((s) =>
        s.group !== null && folded.has(s.group) && !mustStayOpen(s.nodeIds) ? [] : s.nodeIds
      ),
    [sections, folded, mustStayOpen]
  );

  // The one row in the tab order: the selected row if it is showing, else the first.
  const tabStopId =
    selectedNodeId && visibleIds.includes(selectedNodeId) ? selectedNodeId : visibleIds[0];

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!KEYS.has(e.key)) {
        return;
      }
      const focusedId =
        (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-outline-id]')
          ?.dataset.outlineId ?? null;
      const target = nextOutlineId(visibleIds, focusedId, e.key as OutlineKey);
      if (!target) {
        return;
      }
      e.preventDefault();
      onSelect?.(target);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(target)}"]`)
        ?.focus();
    },
    [visibleIds, onSelect]
  );

  const toggle = (group: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(group)) {
        next.add(group);
      }
      return next;
    });

  if (sections.length === 0) {
    return (
      <div
        className={cn('p-4 font-mono text-[11px] text-paper-500', className)}
        style={{ height: height ?? 'auto' }}
      >
        This workflow has no steps.
      </div>
    );
  }

  return (
    <nav
      aria-label="Workflow outline"
      className={cn('overflow-y-auto bg-ink-900', className)}
      style={{ height: height ?? 480 }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the keydown only handles arrow navigation between the buttons inside */}
      <div onKeyDown={onKeyDown} ref={listRef}>
        <ol className="m-0 list-none p-0">
          {sections.map((section) => {
            const key = section.group ?? section.nodeIds[0];
            const open =
              section.group === null || !folded.has(section.group) || mustStayOpen(section.nodeIds);
            const ran = statuses
              ? section.nodeIds.filter((id) => statuses.byNodeId[id]).length
              : undefined;
            return (
              <li key={key}>
                {section.group !== null && (
                  <h4 className="m-0 border-y border-ink-600/40 bg-ink-800/60">
                    <button
                      aria-expanded={open}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-[0.16em] text-paper-400 hover:text-paper-100"
                      onClick={() => toggle(section.group as string)}
                      title={
                        mustStayOpen(section.nodeIds)
                          ? 'Held open: it contains the selected step, a failed, running or pending step, or a diff mark.'
                          : undefined
                      }
                      type="button"
                    >
                      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                      <span className="flex-1 truncate">{section.group}</span>
                      <span className="tabular text-paper-500">
                        {ran !== undefined ? `${ran}/` : ''}
                        {section.nodeIds.length}
                      </span>
                    </button>
                  </h4>
                )}
                {open && (
                  <ol className="m-0 list-none p-0">
                    {section.nodeIds.map((id) => {
                      const node = spec.nodes[id];
                      if (!node) {
                        return null;
                      }
                      const status = statuses?.byNodeId[id];
                      const diff = diffMarkers?.[id];
                      const selected = id === selectedNodeId;
                      const titled = hasDisplayTitle(node, id);
                      return (
                        <li key={id}>
                          <button
                            aria-current={selected ? 'true' : undefined}
                            className={cn(
                              'flex w-full items-center gap-2 border-l-[3px] px-3 py-1.5 text-left transition-colors',
                              NODE_TYPE_TONE[node.type].border,
                              selected
                                ? 'bg-ember-400/10 text-paper-50'
                                : 'text-paper-200 hover:bg-ink-700/60',
                              section.group !== null && 'pl-5'
                            )}
                            data-outline-id={id}
                            onClick={() => onSelect?.(id)}
                            tabIndex={id === tabStopId ? 0 : -1}
                            type="button"
                          >
                            <span className="tabular w-6 shrink-0 text-right font-mono text-[10px] text-paper-600">
                              {numbering.get(id)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-display text-[13px] leading-tight">
                                {nodeDisplayName(node, id)}
                              </span>
                              <span className="block truncate font-mono text-[10px] text-paper-500">
                                {node.type}
                                {node.type === 'step' && ` · ${node.step}`}
                                {titled && ` · ${id}`}
                              </span>
                            </span>
                            {diff && (
                              <span
                                className={cn(
                                  'font-mono text-[10px] uppercase tracking-[0.12em]',
                                  DIFF_TEXT[diff]
                                )}
                              >
                                {diff}
                              </span>
                            )}
                            {status && (
                              <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-paper-300">
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    'h-1.5 w-1.5 rounded-full',
                                    STATUS_DOT[status.status] ?? 'bg-paper-500',
                                    status.status === 'RUNNING' && 'pulse-dot'
                                  )}
                                />
                                {status.status.toLowerCase()}
                                {status.attempt > 1 && (
                                  <span className="text-paper-500">×{status.attempt}</span>
                                )}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
