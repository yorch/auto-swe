import { describe, expect, it } from 'vitest';
import { DOCS_MAINTAINER_PROMPT } from '../../lib/agentPrompts.js';
import { type Node, WorkflowSpecSchema } from '../spec.js';
import { DOCS_REFRESH_ALLOWED_PATHS, DOCS_REFRESH_SPEC as spec } from './docsRefresh.js';

const nodes = spec.nodes as Record<string, Node & Record<string, unknown>>;

describe('DOCS_REFRESH_SPEC', () => {
  it('parses as a valid WorkflowSpec', () => {
    expect(WorkflowSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('confines the implementation to documentation, in the step that writes', () => {
    expect(DOCS_REFRESH_ALLOWED_PATHS).toEqual(['**/*.md', 'docs/']);
    expect(nodes.implement).toMatchObject({
      config: { allowedPaths: DOCS_REFRESH_ALLOWED_PATHS, systemPrompt: DOCS_MAINTAINER_PROMPT },
      step: 'executeImplementation',
    });
  });

  it('opens a draft pull request only when something changed', () => {
    expect(nodes.checkChanges).toMatchObject({
      expr: 'nodes.implement.output.filesChanged.length == 0',
      onFalse: 'storeCodeResult',
      onTrue: 'doneNoChange',
    });
    expect(nodes.openPR).toMatchObject({ config: { draft: true } });
    expect(nodes.doneNoChange).toMatchObject({
      result: { changed: { literal: false } },
      status: 'SUCCESS',
    });
  });

  it('has no CI loop and no human step: the draft is the control', () => {
    const types = new Set(Object.values(nodes).map((n) => n.type));
    expect([...types].some((t) => t.startsWith('human'))).toBe(false);
    expect(Object.keys(nodes).some((id) => /ci/i.test(id))).toBe(false);
  });
});

describe('DOCS_MAINTAINER_PROMPT', () => {
  it('says the three things the design depends on: verify, markdown only, empty diff is fine', () => {
    expect(DOCS_MAINTAINER_PROMPT).toMatch(/Check every concrete claim against it/);
    expect(DOCS_MAINTAINER_PROMPT).toMatch(/Only markdown files may change/);
    expect(DOCS_MAINTAINER_PROMPT).toMatch(/an empty diff is a correct result/);
  });
});
