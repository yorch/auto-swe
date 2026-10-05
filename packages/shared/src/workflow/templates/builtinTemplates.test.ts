import { describe, expect, it } from 'vitest';
import { findInvalidPresentation, WorkflowSpecSchema } from '../spec.js';
import { validateSpec } from '../validateSpec.js';
import { BUILTIN_TEMPLATES } from './index.js';

describe.each(BUILTIN_TEMPLATES.map((t) => [t.name, t.spec] as const))(
  'built-in %s',
  (_name, spec) => {
    it('parses as a WorkflowSpec', () => {
      expect(WorkflowSpecSchema.safeParse(spec).success).toBe(true);
    });

    it('validates with no errors and no unreachable nodes', () => {
      const report = validateSpec(spec);
      expect(report.errors).toEqual([]);
      expect(
        report.warnings.filter((i) =>
          [
            'UNREACHABLE',
            'FANOUT_LEAK',
            'TERMINAL_IN_SUBGRAPH_ONLY',
            'IGNORED_FIELD',
            'GROUP_NOT_CONTIGUOUS',
          ].includes(i.code)
        )
      ).toEqual([]);
    });

    it('holds its group and title to the authoring limits, as stored (not as a tolerant parse leaves them)', () => {
      expect(findInvalidPresentation(spec)).toEqual([]);
    });

    it('does not stamp COMPLETED itself: the finalizer writes it when the run ends SUCCESS', () => {
      for (const [id, node] of Object.entries(spec.nodes)) {
        const stampsCompleted =
          node.type === 'step' &&
          node.step === 'updateDomainState' &&
          node.config?.status === 'COMPLETED';
        expect(stampsCompleted, id).toBe(false);
      }
    });

    it('gives every node a group, so the outline has no loose nodes', () => {
      const loose = Object.entries(spec.nodes)
        .filter(([id, node]) => !node.group && !(id === 'done' || node.type === 'terminate'))
        .map(([id]) => id);
      expect(loose).toEqual([]);
    });

    it('never routes publishOutcome straight into writeOutcome', () => {
      // publishOutcome records an autonomy decision; a write that follows it directly
      // ignores that decision, so the audit log would say "approval required" while
      // the write happens anyway. A branch on the decision has to sit between them.
      for (const [id, node] of Object.entries(spec.nodes)) {
        if (node.type !== 'step' || node.step !== 'publishOutcome' || !node.next) {
          continue;
        }
        const target = spec.nodes[node.next];
        const isWrite = target?.type === 'step' && target.step === 'writeOutcome';
        expect(isWrite, `${id} -> ${node.next}`).toBe(false);
      }
    });
  }
);

describe('built-in template descriptions', () => {
  // Shown to people choosing a workflow, so they read as plain language: no node types, step
  // names or `key=value` settings from the spec.
  it.each(BUILTIN_TEMPLATES.map((t) => [t.name, t.description] as const))(
    '%s names no internal identifiers',
    (_name, description) => {
      expect(description).not.toMatch(/\b[a-z]+[A-Z]\w*\b/);
      expect(description).not.toMatch(/\w=\d|\b[A-Z]+_[A-Z_]+\b/);
      expect(description).not.toMatch(/\b(fanOut|pluck|HITL)\b/);
    }
  );
});
