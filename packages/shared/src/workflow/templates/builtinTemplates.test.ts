import { describe, expect, it } from 'vitest';
import { WorkflowSpecSchema } from '../spec.js';
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
          ['UNREACHABLE', 'FANOUT_LEAK', 'TERMINAL_IN_SUBGRAPH_ONLY', 'IGNORED_FIELD'].includes(
            i.code
          )
        )
      ).toEqual([]);
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
