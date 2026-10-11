'use client';

/**
 * NodePalette — left rail in the TemplateEditor. Lists the available primitive
 * node types and registered step implementations. Each item is HTML5-draggable;
 * the TemplateEditor canvas listens for `onDrop` to actually mutate the spec.
 *
 * Primitives are grouped into collapsible sections to reduce visual noise.
 */

import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { z } from 'zod';
import { EmptyState } from '@/components/ui/EmptyState';
import { HelpTip } from '@/components/ui/HelpTip';
import { Icon } from '@/components/ui/Icon';
import { SearchInput } from '@/components/ui/Toolbar';
import { nodeHelp } from '@/lib/nodeHelp';
import { cn, FOCUS_RING } from '@/lib/utils';
import { CONTAINER_AUTHORING_RULE } from './containerNodes';
import { NODE_TYPE_LABEL, NODE_TYPE_TONE } from './nodeTypeTone';

export const PaletteDragSchema = z.union([
  z.object({ kind: z.literal('primitive'), nodeType: z.string() }),
  z.object({ kind: z.literal('step'), step: z.string() }),
]);

export type PaletteDragKind = z.infer<typeof PaletteDragSchema>;

export const PALETTE_MIME = 'application/x-auto-swe-palette';

const GROUP_ORDER = ['Execution', 'Control flow', 'Human-in-loop', 'Advanced'] as const;

type GroupLabel = (typeof GROUP_ORDER)[number];

type PrimitiveDef = {
  hint: string;
  /** A short worked example, shown under the hint. */
  example?: string;
  group: GroupLabel;
  elevated?: boolean;
};

type PrimitiveGroup = {
  label: GroupLabel;
  items: (PrimitiveDef & { label: string; type: SpecNode['type'] })[];
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
  },
  cond: {
    example: 'e.g. nodes.review.output.approved == true',
    group: 'Control flow',
    hint: 'Branch on an expression: true goes one way, false the other',
  },
  containerStep: {
    elevated: true,
    group: 'Advanced',
    hint: 'Coded capability container, JSON in and out',
  },
  eval: {
    group: 'Execution',
    hint: 'Score a value with a scorer',
  },
  fanOut: {
    group: 'Control flow',
    hint: 'Fan out into parallel subtasks',
  },
  humanApproval: {
    group: 'Human-in-loop',
    hint: 'Pause for human approval',
  },
  humanDecision: {
    group: 'Human-in-loop',
    hint: 'Pause for human decision',
  },
  humanInput: {
    group: 'Human-in-loop',
    hint: 'Pause for human input',
  },
  humanReview: {
    group: 'Human-in-loop',
    hint: 'Pause for human review',
  },
  mcp: {
    group: 'Execution',
    hint: 'Call one tool on an MCP server',
  },
  set: { group: 'Control flow', hint: 'Set spec values' },
  shell: {
    elevated: true,
    group: 'Advanced',
    hint: 'Run a shell command in a container',
  },
  signal: {
    example: 'e.g. name humanMergeSignal, timeout 7d',
    group: 'Control flow',
    hint: 'Wait for an external signal, or time out',
  },
  step: {
    group: 'Execution',
    hint: 'Run a registered step',
  },
  terminate: {
    group: 'Control flow',
    hint: 'End the workflow',
  },
};

/** Saving a shell or container-step node is gated by the gateway (see `CONTAINER_AUTHORING_RULE`). */
const ELEVATED_NOTE = `Elevated. ${CONTAINER_AUTHORING_RULE}`;

const PRIMITIVE_TYPES = Object.keys(PRIMITIVES) as SpecNode['type'][];

export const PRIMITIVE_GROUPS: PrimitiveGroup[] = GROUP_ORDER.map((label) => ({
  items: PRIMITIVE_TYPES.filter((type) => PRIMITIVES[type].group === label).map((type) => ({
    ...PRIMITIVES[type],
    label: NODE_TYPE_LABEL[type],
    type,
  })),
  label,
}));

/** What the shared "Node help" panel shows for the item the pointer or keyboard focus is on. */
type ActiveHelp = { id: string; label: string; text?: string; note?: string; mono?: boolean };

/**
 * Reports which item is hovered or focused; the palette keeps one help panel for all of them.
 * Clearing names the item (`id`) so an item that is leaving cannot clear another one's help.
 */
type Activate = (source: 'hover' | 'focus', help: ActiveHelp | null, clearedId?: string) => void;

interface StepEntry {
  name: string;
  label: string;
  category: string;
  description?: string;
}

interface Props {
  steps: StepEntry[];
  /** Keyboard alternative to drag-and-drop: Enter/Space on an item adds it. */
  onAdd: (payload: PaletteDragKind) => void;
}

function PrimitiveGroup({
  group,
  onAdd,
  onActivate,
}: {
  group: PrimitiveGroup;
  onAdd: (payload: PaletteDragKind) => void;
  onActivate: Activate;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-1">
      <button
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-xs font-medium text-paper-400 transition-colors hover:text-paper-100',
          FOCUS_RING
        )}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <Icon
          className={cn('text-paper-500 transition-transform', open && 'rotate-90')}
          name="chevronRight"
          size={12}
        />
        <span>{group.label}</span>
        <span className="ml-auto text-paper-500 tabular-nums">{group.items.length}</span>
      </button>
      {open && (
        <ul className="space-y-1 pb-1">
          {group.items.map((p) => (
            <PaletteItem
              description={`${nodeHelp(p.type).what} Use it when: ${nodeHelp(p.type).when}`}
              dragPayload={{ kind: 'primitive', nodeType: p.type }}
              elevated={p.elevated}
              example={p.example}
              hint={p.hint}
              key={p.type}
              label={p.label}
              onActivate={onActivate}
              onAdd={onAdd}
              swatch={NODE_TYPE_TONE[p.type].swatch}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function NodePalette({ steps, onAdd }: Props) {
  const [query, setQuery] = useState('');
  // One help panel for every item (a "?" beside each of the 15 node types was 15 extra tab stops).
  // The most recent interaction (hover or focus) wins; each clears on leave/blur, and an item
  // that unmounts (filtered out, group collapsed) clears itself, since it gets neither event.
  const [hovered, setHovered] = useState<ActiveHelp | null>(null);
  const [focused, setFocused] = useState<ActiveHelp | null>(null);
  const [latest, setLatest] = useState<'hover' | 'focus'>('focus');
  const activate: Activate = useCallback((source, help, clearedId) => {
    const set = source === 'hover' ? setHovered : setFocused;
    if (help) {
      set(help);
      setLatest(source);
    } else {
      set((cur) => (cur && (clearedId === undefined || cur.id === clearedId) ? null : cur));
    }
  }, []);
  const activeHelp = latest === 'hover' ? (hovered ?? focused) : (focused ?? hovered);

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
    <aside
      aria-label="Add a node"
      className="flex h-full w-64 flex-col border-r border-ink-600 bg-ink-950"
    >
      {/* Only this region scrolls. The help panel below is a sibling that takes its own height,
          not a sticky overlay on the scroller, so keyboard focus never scrolls an item behind it. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-ink-600 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-paper-100">Add a node</h2>
            <HelpTip term="node" />
          </div>
          <p className="mt-0.5 text-xs leading-snug text-paper-500">
            Drag onto the canvas, or focus and press Enter
          </p>
        </div>

        {/* Primitives — grouped */}
        <div className="border-b border-ink-600 px-3 py-3">
          <h3 className="mb-1 px-1 text-[13px] font-semibold text-paper-200">Node types</h3>
          {PRIMITIVE_GROUPS.map((g) => (
            <PrimitiveGroup group={g} key={g.label} onActivate={activate} onAdd={onAdd} />
          ))}
        </div>

        {/* Steps */}
        <div className="flex flex-col">
          <div className="sticky top-0 z-10 border-b border-ink-600 bg-ink-950 px-3 py-3">
            <h3 className="mb-2 px-1 text-[13px] font-semibold text-paper-200">
              Registered steps
              <span className="ml-1.5 font-normal text-paper-500 tabular-nums">{steps.length}</span>
            </h3>
            <SearchInput
              className="sm:w-full"
              label="Filter the step registry"
              onChange={setQuery}
              placeholder="Filter steps…"
              value={query}
            />
          </div>
          <div className="px-3 py-3">
            {groupedSteps.length === 0 && (
              <EmptyState
                className="py-4"
                hint="Try a step name or category."
                icon={null}
                title="No steps match"
              />
            )}
            {groupedSteps.map(([category, items]) => (
              <div className="mb-4 last:mb-0" key={category}>
                <div className="mb-1 px-1 text-xs font-medium text-paper-500">{category}</div>
                <ul className="space-y-1">
                  {items.map((s) => (
                    <PaletteItem
                      description={s.description}
                      dragPayload={{ kind: 'step', step: s.name }}
                      hint={s.label}
                      key={s.name}
                      label={s.name}
                      mono
                      onActivate={activate}
                      onAdd={onAdd}
                      swatch={NODE_TYPE_TONE.step.swatch}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      <NodeHelpRegion active={activeHelp} />
    </aside>
  );
}

function NodeHelpRegion({ active }: { active: ActiveHelp | null }) {
  return (
    <section
      aria-labelledby="palette-help-heading"
      className="max-h-48 shrink-0 overflow-y-auto border-t border-ink-600 bg-ink-950 px-4 py-3 text-xs leading-snug"
      data-testid="palette-help"
    >
      <h3 className="mb-1 text-[13px] font-semibold text-paper-200" id="palette-help-heading">
        Node help
      </h3>
      {active ? (
        <>
          <p className={cn('font-medium text-paper-100', active.mono && 'font-mono')}>
            {active.label}
          </p>
          {active.text && <p className="mt-0.5 text-paper-400">{active.text}</p>}
          {active.note && (
            <p className="mt-1 flex items-start gap-1 text-brick-400">
              <Icon className="mt-px shrink-0" name="lock" size={12} />
              <span>{active.note}</span>
            </p>
          )}
        </>
      ) : (
        <p className="text-paper-500">Focus or hover a node to read what it does.</p>
      )}
    </section>
  );
}

function PaletteItem({
  label,
  hint,
  example,
  swatch,
  dragPayload,
  description,
  elevated,
  mono = false,
  onActivate,
  onAdd,
}: {
  label: string;
  hint?: string;
  example?: string;
  swatch: string;
  dragPayload: PaletteDragKind;
  /** What the item is, read as its accessible description and shown in the palette's help panel. */
  description?: string;
  elevated?: boolean;
  /** The label is an identifier (a registered step name), shown in mono. */
  mono?: boolean;
  onActivate: Activate;
  onAdd: (payload: PaletteDragKind) => void;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const lockId = `${id}-lock`;
  const help: ActiveHelp = {
    id,
    label,
    mono,
    ...(description ? { text: description } : {}),
    ...(elevated ? { note: ELEVATED_NOTE } : {}),
  };
  // An unmounting item gets no blur or mouseleave; leave no help behind for it.
  useEffect(
    () => () => {
      onActivate('hover', null, id);
      onActivate('focus', null, id);
    },
    [id, onActivate]
  );
  const describedBy = [description ? descId : null, elevated ? lockId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <li className="flex items-start gap-1">
      {/* biome-ignore lint/a11y/useSemanticElements: <button draggable> does not reliably fire drag events across browsers; div uses role="button" for accessibility. */}
      <div
        aria-describedby={describedBy || undefined}
        aria-label={`Add ${label} node`}
        aria-roledescription="draggable palette item"
        className={cn(
          'group flex min-w-0 flex-1 cursor-grab items-center gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors hover:border-ink-300 hover:bg-ink-700 focus-visible:border-ember-400 focus-visible:bg-ink-700 active:cursor-grabbing',
          FOCUS_RING,
          elevated ? 'border-brick-400/30 bg-brick-400/5' : 'border-ink-600 bg-ink-800/50'
        )}
        draggable
        onBlur={() => onActivate('focus', null, id)}
        onDragStart={(e) => {
          e.dataTransfer.setData(PALETTE_MIME, JSON.stringify(dragPayload));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onFocus={() => onActivate('focus', help)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onAdd(dragPayload);
          }
        }}
        onMouseEnter={() => onActivate('hover', help)}
        onMouseLeave={() => onActivate('hover', null, id)}
        role="button"
        tabIndex={0}
      >
        <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', swatch)} />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'truncate text-paper-100',
              mono ? 'font-mono text-xs' : 'text-[13px] font-medium'
            )}
          >
            {label}
          </div>
          {hint && (
            <div className={cn('text-[11px] text-paper-500', !example && 'truncate')}>{hint}</div>
          )}
          {example && (
            <div className="mt-0.5 break-words font-mono text-[11px] text-paper-400">{example}</div>
          )}
        </div>
        {elevated && (
          <span className="shrink-0 text-brick-400">
            <Icon name="lock" size={13} />
            <span hidden id={lockId}>
              {ELEVATED_NOTE}
            </span>
          </span>
        )}
      </div>
      {description && (
        <span hidden id={descId}>
          {description}
        </span>
      )}
    </li>
  );
}
