import { describe, expect, it } from 'vitest';
import { MACROS } from '../workflow/macros.js';
import { WORKFLOW_AUTHOR_PROMPT } from './agentPrompts.js';

/** Prompt text for one macro: its `- <ref>:` bullet up to the next bullet or blank line. */
function bullet(ref: string): string {
  const start = WORKFLOW_AUTHOR_PROMPT.indexOf(`- ${ref}:`);
  expect(start, `the workflow author prompt documents ${ref}`).toBeGreaterThanOrEqual(0);
  const rest = WORKFLOW_AUTHOR_PROMPT.slice(start + 1);
  const end = rest.search(/\n(- |\n)/);
  return end < 0 ? rest : rest.slice(0, end);
}

// The prompt is prose; this keeps it from drifting from the macro registry. A new macro or
// version fails here until the author prompt says what it is, where it is entered and what
// it routes to.
describe('WORKFLOW_AUTHOR_PROMPT macros section', () => {
  it('names every registered macro except the superseded ciLoop@1 as a bullet', () => {
    for (const ref of Object.keys(MACROS)) {
      if (ref === 'ciLoop@1') {
        expect(WORKFLOW_AUTHOR_PROMPT).toContain('ciLoop@1');
        continue;
      }
      bullet(ref);
    }
  });

  it('states each macro entry node and the arguments that route to other nodes', () => {
    const samples: Record<string, Array<Record<string, unknown>>> = {
      'ciLoop@2': [
        { fix: false, passed: 'x' },
        { fix: false, passed: 'x', wait: 'pollOrSignal' },
      ],
      'openPullRequest@1': [{ next: 'x' }],
      'reviewLoop@1': [{ approved: 'x' }],
      'validatePhase@1': [{ next: 'x' }, { next: 'x', ticketContext: true }],
    };
    for (const [ref, argSets] of Object.entries(samples)) {
      const def = MACROS[ref];
      expect(def, ref).toBeDefined();
      const text = bullet(ref);
      for (const args of argSets) {
        expect(text, `${ref} entry`).toContain(`"${def?.entry(args)}"`);
      }
      for (const path of def?.edgeArgs ?? []) {
        expect(text, `${ref} edge arg ${path}`).toContain(`"${path.split('.').pop()}"`);
      }
      for (const path of def?.nodeIdArgs ?? []) {
        expect(text, `${ref} node id arg ${path}`).toContain(`"${path.split('.').pop()}"`);
      }
    }
    expect(Object.keys(samples).sort()).toEqual(
      Object.keys(MACROS)
        .filter((r) => r !== 'ciLoop@1')
        .sort()
    );
  });

  it('tells the author to keep a refinement flat', () => {
    expect(WORKFLOW_AUTHOR_PROMPT).toMatch(/REFINE[\s\S]*FLAT[\s\S]*never write "uses"/);
  });
});
