'use client';

/**
 * NodePalette — left rail in the TemplateEditor. Lists the available primitive
 * node types and registered step implementations. Each item is HTML5-draggable;
 * the TemplateEditor canvas listens for `onDrop` to actually mutate the spec.
 *
 * Primitives are grouped into collapsible sections to reduce visual noise.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type PaletteDragKind =
  | { kind: 'primitive'; nodeType: SpecNode['type'] }
  | { kind: 'step'; step: string };

export const PALETTE_MIME = 'application/x-auto-swe-palette';

const GROUP_ORDER = ['Execution', 'Control flow', 'Human-in-loop', 'Advanced'] as const;

type GroupLabel = (typeof GROUP_ORDER)[number];

type PrimitiveDef = {
  label: string;
  hint: string;
  swatch: string;
  group: GroupLabel;
  elevated?: boolean;
};

type PrimitiveGroup = {
  label: GroupLabel;
  items: (PrimitiveDef & { type: SpecNode['type'] })[];
};

/**
 * Every primitive node type, in the order the palette lists them.
 *
 * Keyed as a `Record` over the `Node` union rather than nested inside the
 * groups: as a plain array this silently omitted `eval`, so there was no way
 * to create an eval node from the editor at all. A `Record` makes the next
 * node type a compile error here instead.
 */
const PRIMITIVES: Record<SpecNode['type'], PrimitiveDef> = {
  agent: {
    group: 'Execution',
    hint: 'Run a library Agent by reference',
    label: 'Agent',
    swatch: 'bg-ember-300',
  },
  cond: {
    group: 'Control flow',
    hint: 'Branch on an expression',
    label: 'Conditional',
    swatch: 'bg-violet-400',
  },
  containerStep: {
    elevated: true,
    group: 'Advanced',
    hint: 'Coded capability container — JSON in/out (⚠ elevated)',
    label: 'Container step',
    swatch: 'bg-brick-400',
  },
  eval: {
    group: 'Execution',
    hint: 'Score a value with a scorer',
    label: 'Eval',
    swatch: 'bg-moss-400',
  },
  fanOut: {
    group: 'Control flow',
    hint: 'Fan out into parallel subtasks',
    label: 'Fan-out',
    swatch: 'bg-moss-400',
  },
  humanApproval: {
    group: 'Human-in-loop',
    hint: 'Pause for human approval',
    label: 'Approval',
    swatch: 'bg-amber-500',
  },
  humanDecision: {
    group: 'Human-in-loop',
    hint: 'Pause for human decision',
    label: 'Decision',
    swatch: 'bg-amber-500',
  },
  humanInput: {
    group: 'Human-in-loop',
    hint: 'Pause for human input',
    label: 'Input',
    swatch: 'bg-amber-500',
  },
  humanReview: {
    group: 'Human-in-loop',
    hint: 'Pause for human review',
    label: 'Review',
    swatch: 'bg-amber-500',
  },
  mcp: {
    group: 'Execution',
    hint: 'Call one tool on an MCP server',
    label: 'MCP tool',
    swatch: 'bg-dust-400',
  },
  set: { group: 'Control flow', hint: 'Set spec values', label: 'Set', swatch: 'bg-amber-400' },
  shell: {
    elevated: true,
    group: 'Advanced',
    hint: 'Run a shell command (⚠ elevated)',
    label: 'Shell',
    swatch: 'bg-brick-400',
  },
  signal: {
    group: 'Control flow',
    hint: 'Wait for an external signal',
    label: 'Signal',
    swatch: 'bg-dust-400',
  },
  step: {
    group: 'Execution',
    hint: 'Run a registered step',
    label: 'Step',
    swatch: 'bg-ember-400',
  },
  terminate: {
    group: 'Control flow',
    hint: 'End the workflow',
    label: 'Terminate',
    swatch: 'bg-paper-500',
  },
};

const PRIMITIVE_TYPES = Object.keys(PRIMITIVES) as SpecNode['type'][];

export const PRIMITIVE_GROUPS: PrimitiveGroup[] = GROUP_ORDER.map((label) => ({
  items: PRIMITIVE_TYPES.filter((type) => PRIMITIVES[type].group === label).map((type) => ({
    ...PRIMITIVES[type],
    type,
  })),
  label,
}));

interface StepEntry {
  name: string;
  label: string;
  category: string;
  description?: string;
}

interface Props {
  steps: StepEntry[];
}

function PrimitiveGroup({ group }: { group: PrimitiveGroup }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-1">
      <button
        className="flex w-full items-center justify-between px-1 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-paper-600 hover:text-paper-400"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span>{group.label}</span>
        <span className="text-[8px]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="space-y-1">
          {group.items.map((p) => (
            <PaletteItem
              dragPayload={{ kind: 'primitive', nodeType: p.type }}
              elevated={p.elevated}
              hint={p.hint}
              key={p.type}
              label={p.label}
              swatch={p.swatch}
            />
          ))}
        </ul>
      )}
    </div>
  );
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

      {/* Primitives — grouped */}
      <div className="border-b border-ink-600 px-3 py-3">
        <div className="mb-1 px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
          Primitives
        </div>
        {PRIMITIVE_GROUPS.map((g) => (
          <PrimitiveGroup group={g} key={g.label} />
        ))}
      </div>

      {/* Steps */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-ink-600 px-3 py-3">
          <div className="mb-2 px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
            Step registry
          </div>
          <input
            aria-label="Filter the step registry"
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
  elevated,
}: {
  label: string;
  hint?: string;
  swatch: string;
  dragPayload: PaletteDragKind;
  title?: string;
  elevated?: boolean;
}) {
  return (
    <li>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag source needs to be a div with draggable + onDragStart; <button draggable> doesn't fire the drag events reliably across browsers. */}
      <div
        className={cn(
          'group flex cursor-grab items-center gap-2 rounded-sm border px-2 py-1.5 text-xs transition-colors hover:border-ember-400 hover:bg-ink-700 active:cursor-grabbing',
          elevated ? 'border-brick-400/40 bg-brick-400/5' : 'border-ink-600 bg-ink-800/50'
        )}
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
        {elevated && (
          <span className="text-[9px] text-brick-400" title="Requires team-admin authoring">
            ⚠
          </span>
        )}
      </div>
    </li>
  );
}
