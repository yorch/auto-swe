'use client';

/**
 * NodePalette — left rail in the TemplateEditor. Lists the available primitive
 * node types and registered step implementations. Each item is HTML5-draggable;
 * the TemplateEditor canvas listens for `onDrop` to actually mutate the spec.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type PaletteDragKind =
  | { kind: 'primitive'; nodeType: SpecNode['type'] }
  | { kind: 'step'; step: string };

export const PALETTE_MIME = 'application/x-auto-swe-palette';

type PrimitiveDef = {
  type: SpecNode['type'];
  label: string;
  hint: string;
  swatch: string;
};

const PRIMITIVES: PrimitiveDef[] = [
  { hint: 'Run a registered step', label: 'Step', swatch: 'bg-ember-400', type: 'step' },
  { hint: 'Branch on an expression', label: 'Conditional', swatch: 'bg-violet-400', type: 'cond' },
  { hint: 'Set spec values', label: 'Set', swatch: 'bg-amber-400', type: 'set' },
  { hint: 'Wait for an external signal', label: 'Signal', swatch: 'bg-dust-400', type: 'signal' },
  {
    hint: 'Fan out into parallel subtasks',
    label: 'Fan-out',
    swatch: 'bg-moss-400',
    type: 'fanOut',
  },
  {
    hint: 'Run a shell command (⚠ elevated)',
    label: 'Shell',
    swatch: 'bg-brick-400',
    type: 'shell',
  },
  { hint: 'End the workflow', label: 'Terminate', swatch: 'bg-paper-500', type: 'terminate' },
];

interface StepEntry {
  name: string;
  label: string;
  category: string;
  description?: string;
}

interface Props {
  steps: StepEntry[];
}

export function NodePalette({ steps }: Props) {
  const [query, setQuery] = useState('');

  const filteredSteps = useMemo(() => {
    if (!query.trim()) {
      return steps;
    }
    const q = query.toLowerCase();
    return steps.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q)
    );
  }, [steps, query]);

  const groupedSteps = useMemo(() => {
    const map = new Map<string, StepEntry[]>();
    for (const s of filteredSteps) {
      const bucket = map.get(s.category) ?? [];
      bucket.push(s);
      map.set(s.category, bucket);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredSteps]);

  return (
    <aside className="flex h-full w-64 flex-col border-r border-ink-600 bg-ink-950/40">
      <div className="border-b border-ink-600 px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
          ¶ Palette
        </div>
        <p className="mt-1 text-[11px] leading-snug text-paper-400">
          Drag onto the canvas to add a node.
        </p>
      </div>

      {/* Primitives */}
      <div className="border-b border-ink-600 px-3 py-3">
        <div className="mb-2 px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
          Primitives
        </div>
        <ul className="space-y-1">
          {PRIMITIVES.map((p) => (
            <PaletteItem
              dragPayload={{ kind: 'primitive', nodeType: p.type }}
              hint={p.hint}
              key={p.type}
              label={p.label}
              swatch={p.swatch}
            />
          ))}
        </ul>
      </div>

      {/* Steps */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-ink-600 px-3 py-3">
          <div className="mb-2 px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
            Step registry
          </div>
          <input
            className="h-7 w-full rounded-sm border border-ink-500 bg-ink-900/60 px-2 text-xs text-paper-100 outline-none placeholder:text-paper-600 focus:border-ember-400"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter steps…"
            type="search"
            value={query}
          />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {groupedSteps.length === 0 && (
            <div className="px-1 py-3 text-center font-mono text-[10px] uppercase tracking-wider text-paper-500">
              — no matches —
            </div>
          )}
          {groupedSteps.map(([category, items]) => (
            <div className="mb-4" key={category}>
              <div className="mb-1 px-1 font-mono text-[9px] uppercase tracking-[0.18em] text-paper-600">
                {category}
              </div>
              <ul className="space-y-px">
                {items.map((s) => (
                  <PaletteItem
                    dragPayload={{ kind: 'step', step: s.name }}
                    hint={s.label}
                    key={s.name}
                    label={s.name}
                    swatch="bg-ember-400"
                    title={s.description}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function PaletteItem({
  label,
  hint,
  swatch,
  dragPayload,
  title,
}: {
  label: string;
  hint?: string;
  swatch: string;
  dragPayload: PaletteDragKind;
  title?: string;
}) {
  return (
    <li>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag source needs to be a div with draggable + onDragStart; <button draggable> doesn't fire the drag events reliably across browsers. */}
      <div
        className="group flex cursor-grab items-center gap-2 rounded-sm border border-ink-600 bg-ink-800/50 px-2 py-1.5 text-xs transition-colors hover:border-ember-400 hover:bg-ink-700 active:cursor-grabbing"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(dragPayload));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        title={title}
      >
        <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', swatch)} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[11px] text-paper-100">{label}</div>
          {hint && <div className="truncate text-[10px] text-paper-500">{hint}</div>}
        </div>
      </div>
    </li>
  );
}
