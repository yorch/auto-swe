import type { PageTourStep } from '@/lib/tourSteps';

/**
 * Per-page tours, started from the Help panel on the page that registers them (`PageTour`). A
 * step's `anchor` is a `data-tour` attribute that page renders. An anchor that is hidden when the
 * step is reached (the inspector with nothing selected still renders; the palette is a drawer
 * below the lg breakpoint) shows the card centred instead. `pageTours.test.tsx` checks each
 * anchor appears in the source of the page that owns it.
 */
export const EDITOR_TOUR: PageTourStep[] = [
  {
    anchor: 'editor:palette',
    body: 'Open Add node for the palette. Hover or focus an item for help, then click or drag it onto the canvas. Palette and Outline share the left panel.',
    id: 'editor-palette',
    title: 'Palette',
  },
  {
    anchor: 'editor:canvas',
    body: 'The workflow as a graph. Click a node to edit it and drag between nodes to connect them. Delete asks before removing a selected node, only while the canvas has focus. Undo removal is available until the next edit.',
    id: 'editor-canvas',
    title: 'Canvas',
  },
  {
    anchor: 'editor:inspector',
    body: 'Settings for the selected node. Close it to recover canvas space. On narrow screens, node details fill the workspace.',
    id: 'editor-inspector',
    title: 'Node inspector',
  },
  {
    anchor: 'editor:check',
    body: 'Lints the workflow now and asks the server to check it too. Findings appear in the issues panel under the toolbar.',
    id: 'editor-check',
    title: 'Check workflow',
  },
  {
    anchor: 'editor:status',
    body: 'Node count, where the workflow starts, a rough cost estimate per run and, when there are past runs, the observed average.',
    id: 'editor-status',
    title: 'Status bar',
  },
];

export const RUN_TOUR: PageTourStep[] = [
  {
    anchor: 'run:verdict',
    body: 'The run in plain words: its state, and what, if anything, is needed next.',
    id: 'run-verdict',
    title: 'Verdict',
  },
  {
    anchor: 'run:layout',
    body: 'Events, Graph, Timing and Transcript share execution selection. Overview holds approvals and results; Evidence, Activity and Details hold supporting information.',
    id: 'run-layout',
    title: 'Layout',
  },
  {
    anchor: 'run:trace',
    body: 'Select a recorded branch and attempt, or select a graph node to see every matching execution. Review history rewinds events and step states; outcome, cost and approval controls remain latest/final.',
    id: 'run-trace',
    title: 'Trace',
  },
];
