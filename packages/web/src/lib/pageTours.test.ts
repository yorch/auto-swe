// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDITOR_TOUR, RUN_TOUR } from './pageTours';

const SRC = join(__dirname, '..');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

/** Every `data-tour="…"` anchor a tour names must be rendered by the page that registers it. */
const OWNERS: Array<[string, typeof EDITOR_TOUR, string[]]> = [
  [
    'editor',
    EDITOR_TOUR,
    [
      'components/workflow/TemplateEditor.tsx',
      'components/workflow/templateEditor/EditorActionBar.tsx',
      'components/workflow/templateEditor/EditorSideRails.tsx',
      'components/workflow/templateEditor/EditorInspectorPanel.tsx',
      'components/workflow/templateEditor/EditorStatusBar.tsx',
    ],
  ],
  [
    'run page',
    RUN_TOUR,
    [
      'app/runs/[id]/page.tsx',
      'components/runs/RunVerdictBanner.tsx',
      'components/runs/RunWorkspace.tsx',
    ],
  ],
];

describe.each(OWNERS)('%s tour', (_name, steps, files) => {
  const source = files.map(read).join('\n');

  it('points only at anchors the page renders', () => {
    for (const step of steps) {
      expect(source, step.id).toContain(`data-tour="${step.anchor}"`);
    }
  });

  it('has unique step ids and a title and body for every step', () => {
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
  });
});

it('registers each tour from the page that owns it', () => {
  expect(read('components/workflow/TemplateEditor.tsx')).toContain(
    '<PageTour steps={EDITOR_TOUR} />'
  );
  expect(read('app/runs/[id]/page.tsx')).toContain('<PageTour steps={RUN_TOUR} />');
});
