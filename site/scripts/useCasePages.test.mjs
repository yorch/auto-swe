import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWE_AGENTS } from '../../packages/shared/src/lib/syncBuiltins.ts';
import { NodeSchema } from '../../packages/shared/src/workflow/spec.ts';
import { hasStep } from '../../packages/shared/src/workflow/stepRegistry.ts';
import { BUILTIN_TEMPLATES } from '../../packages/shared/src/workflow/templates/index.ts';
import { humanize, specToMermaid, summarizeSpec } from './templateGraph.mjs';
import {
  assertCatalogueCovers,
  describeUseCases,
  renderUseCaseIndex,
  renderUseCasePage,
} from './useCasePages.mjs';
import { USE_CASES, WORKFLOW_IDEAS } from './useCases.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The smallest spec with every shape the renderer treats specially. */
const SPEC = {
  entry: 'markStarted',
  name: 'fixture',
  nodes: {
    approve: {
      onApprove: 'publish',
      onReject: 'rejected',
      onTimeout: 'rejected',
      timeout: '24h',
      title: 'Approve the "draft"',
      type: 'humanApproval',
    },
    done: { status: 'SUCCESS', type: 'terminate' },
    draft: { agentRef: 'contentWriter', next: 'recordStatus', type: 'agent' },
    markStarted: { next: 'draft', type: 'set', values: {} },
    publish: { next: 'waitForMerge', step: 'writeOutcome', type: 'step' },
    recordStatus: { next: 'approve', step: 'updateDomainState', type: 'step' },
    rejected: { status: 'FAILED', type: 'terminate' },
    unreachable: { status: 'SUCCESS', type: 'terminate' },
    waitForMerge: {
      name: 'humanMergeSignal',
      onReceive: 'done',
      onTimeout: 'rejected',
      timeout: '7d',
      type: 'signal',
    },
  },
  schemaVersion: 1,
};

describe('specToMermaid', () => {
  const chart = specToMermaid(SPEC);

  it('folds bookkeeping nodes into the node they lead to', () => {
    expect(chart).not.toContain('n_markStarted');
    expect(chart).not.toContain('n_recordStatus');
    expect(chart).toContain('n_draft --> n_approve');
  });

  it('draws only what the entry can reach', () => {
    expect(chart).not.toContain('n_unreachable');
  });

  it('labels branch edges by what happened', () => {
    expect(chart).toContain('n_approve -->|"approved"| n_publish');
    expect(chart).toContain('n_approve -->|"rejected"| n_rejected');
  });

  // A quote inside a mermaid label ends the label early and breaks the diagram.
  it('escapes quotes in labels', () => {
    expect(chart).toContain('Approve the #quot;draft#quot;');
  });

  it('marks human steps and the merge signal as gates', () => {
    expect(chart).toContain('class n_approve,n_waitForMerge gate');
  });
});

describe('summarizeSpec', () => {
  it('counts the merge signal as a person, not a system wait', () => {
    const { agents, people, waits } = summarizeSpec(SPEC);
    expect(people.map((p) => p.kind)).toEqual(['approval', 'merge']);
    expect(waits).toEqual([]);
    expect(agents).toEqual(['contentWriter']);
  });
});

describe('humanize', () => {
  it('sentence-cases camelCase ids and keeps acronyms', () => {
    expect(humanize('draftResponse')).toBe('Draft response');
    expect(humanize('loadCiWaitConfig')).toBe('Load CI wait config');
    expect(humanize('openPR')).toBe('Open PR');
  });
});

describe('the use-case catalogue', () => {
  it('covers every built-in template, and nothing else', () => {
    expect(() => assertCatalogueCovers(BUILTIN_TEMPLATES, USE_CASES)).not.toThrow();
  });

  it('fails on a template with no entry', () => {
    expect(() =>
      assertCatalogueCovers([...BUILTIN_TEMPLATES, { name: 'brand-new', spec: SPEC }], USE_CASES)
    ).toThrow(/no use-case entry: brand-new/);
  });

  it('fails on an entry whose template is gone', () => {
    const { hotfix, ...rest } = USE_CASES;
    expect(() =>
      assertCatalogueCovers(
        BUILTIN_TEMPLATES.filter((t) => t.name !== 'hotfix'),
        { ...rest, ghost: hotfix, hotfix }
      )
    ).toThrow(/template that does not exist: ghost/);
  });

  it('points every entry at a source file that exists', () => {
    for (const [name, entry] of Object.entries(USE_CASES)) {
      expect(existsSync(join(REPO_ROOT, entry.source)), name).toBe(true);
    }
  });

  // The page must never say "nobody" about a run whose spec has a person in it,
  // nor list a gate the spec does not have.
  it('lists exactly the people each template stops for', () => {
    for (const useCase of describeUseCases()) {
      const page = renderUseCasePage(useCase, { ref: 'main', repoUrl: 'https://x' });
      const gates = (useCase.mermaid.match(/class (\S+) gate/)?.[1] ?? '')
        .split(',')
        .filter(Boolean);
      expect(gates.length, useCase.name).toBe(useCase.facts.people.length);
      expect(page.includes('Nobody inside the run'), useCase.name).toBe(gates.length === 0);
    }
  });
});

describe('workflow ideas', () => {
  const nodeTypes = new Set(NodeSchema.options.map((o) => o.shape.type.value));
  const templates = new Set(BUILTIN_TEMPLATES.map((t) => t.name));
  const agents = new Set(SWE_AGENTS.map((a) => a.key));

  // An idea is prose with no spec behind it, so this is the only thing that
  // keeps it honest: every node, step, template, or agent it names in code
  // formatting must exist, or the page recommends something nobody can build.
  it('names only node types, steps, templates, and agents that exist', () => {
    for (const idea of WORKFLOW_IDEAS) {
      for (const [, name] of idea.builtFrom.matchAll(/`([^`]+)`/g)) {
        const known =
          nodeTypes.has(name) || hasStep(name) || templates.has(name) || agents.has(name);
        expect(known, `${idea.title}: \`${name}\``).toBe(true);
      }
    }
  });

  it('never shares a title with a shipped use case', () => {
    const shipped = new Set(Object.values(USE_CASES).map((u) => u.title));
    for (const idea of WORKFLOW_IDEAS) {
      expect(shipped.has(idea.title), idea.title).toBe(false);
    }
  });

  it('prints the ideas under a heading that says they do not ship', () => {
    const index = renderUseCaseIndex(describeUseCases());
    expect(index).toContain('## Workflows you could build');
    expect(index).toContain('None of these ship.');
    for (const idea of WORKFLOW_IDEAS) {
      expect(index).toContain(`### ${idea.title}`);
    }
  });
});
