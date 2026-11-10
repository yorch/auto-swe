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
    body: 'The node types you can add. Hover or focus an item to read what it does, then click it or drag it onto the canvas. On a narrow screen it opens from Add node.',
    id: 'editor-palette',
    title: 'Palette',
  },
  {
    anchor: 'editor:canvas',
    body: 'The workflow as a graph. Click a node to edit it, drag between nodes to connect them, and press Delete to remove the selected one. Arrow keys follow the flow.',
    id: 'editor-canvas',
    title: 'Canvas',
  },
  {
    anchor: 'editor:inspector',
    body: 'Settings for the selected node. With nothing selected it asks you to pick one.',
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
    body: 'Switch how the trace is shown: Split, Transcript or Timeline. The choice changes the view only, not the run.',
    id: 'run-layout',
    title: 'Layout',
  },
  {
    anchor: 'run:trace',
    body: 'Every step and agent action of the run, and any gate where it is waiting on a person. In the Split layout, selecting a graph node filters the console beside it.',
    id: 'run-trace',
    title: 'Trace',
  },
];
