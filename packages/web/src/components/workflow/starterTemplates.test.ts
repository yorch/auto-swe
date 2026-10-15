import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSchema, parseWorkflowSpec, validateSpec } from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATES } from './starterTemplates';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC_BUILTINS = path.resolve(HERE, '../../../../shared/src/lib/syncBuiltins.ts');

/**
 * Node types no starter teaches, and why. Every other type must be covered by some starter.
 *  - step: runs a registered activity, so a starter would depend on the deployment's step registry
 *    and mostly on engineering-only activities; the editor's help covers it.
 *  - mcp: needs an MCP connection id that exists only in the user's own deployment.
 *  - shell: needs the `workflow:write:shell` permission and an allowlisted image.
 *  - containerStep: same permission and allowlist as shell, plus an image that speaks its contract.
 */
const EXCLUDED = new Set(['step', 'mcp', 'shell', 'containerStep']);

/**
 * What a human node's response holds (`hitlResolve.ts` signals `{ action, resolvedBy, value }`):
 * the answer itself is under `value`, so `context.form.audience` reads nothing while
 * `context.form.value.audience` reads the field.
 */
const RESPONSE_FIELDS = new Set(['action', 'resolvedBy', 'value']);
const HUMAN_TYPES = new Set(['humanApproval', 'humanDecision', 'humanInput', 'humanReview']);
const PATH_KEYS = new Set(['contentFrom', 'contextFrom', 'from']);
const EXPR_PATH = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/g;

/** Every path a spec reads: `from`, `contextFrom` and `contentFrom` values, and paths in exprs. */
function readPaths(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) {
      readPaths(v, out);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (PATH_KEYS.has(k) && typeof v === 'string') {
        out.push(v);
      } else if (k === 'expr' && typeof v === 'string') {
        out.push(...(v.match(EXPR_PATH) ?? []));
      } else {
        readPaths(v, out);
      }
    }
  }
  return out;
}

/** The node count a tagline claims, as in "Set a value, finish · 2 nodes". */
function taglineCount(tagline: string): number | undefined {
  const m = /· (\d+) nodes?$/.exec(tagline);
  return m ? Number(m[1]) : undefined;
}

describe('STARTER_TEMPLATES', () => {
  it('has unique ids and spec names', () => {
    expect(new Set(STARTER_TEMPLATES.map((s) => s.id)).size).toBe(STARTER_TEMPLATES.length);
    expect(new Set(STARTER_TEMPLATES.map((s) => s.spec.name)).size).toBe(STARTER_TEMPLATES.length);
  });

  describe.each(STARTER_TEMPLATES.map((s) => [s.id, s] as const))('%s', (_id, starter) => {
    it('parses as a workflow spec', () => {
      expect(() => parseWorkflowSpec(starter.spec)).not.toThrow();
    });

    it('validates with no errors and no warnings', () => {
      const report = validateSpec(parseWorkflowSpec(starter.spec));
      expect(report.errors).toEqual([]);
      expect(report.warnings).toEqual([]);
    });

    it('teaches exactly the distinct node types it uses', () => {
      const used = new Set(Object.values(starter.spec.nodes).map((n) => n.type));
      expect(new Set(starter.teaches)).toEqual(used);
      expect(new Set(starter.teaches).size).toBe(starter.teaches.length);
    });

    it('states its real node count in the tagline', () => {
      expect(taglineCount(starter.tagline), starter.tagline).toBe(
        Object.keys(starter.spec.nodes).length
      );
    });

    it('reads a human node’s answer through the response envelope (`.value`)', () => {
      const roots: string[] = [];
      for (const [id, node] of Object.entries(starter.spec.nodes)) {
        if (!HUMAN_TYPES.has(node.type)) {
          continue;
        }
        roots.push(`nodes.${id}.output`);
        if ('storeAs' in node && node.storeAs) {
          roots.push(node.storeAs);
        }
      }
      for (const p of readPaths(starter.spec.nodes)) {
        for (const root of roots) {
          if (p.startsWith(`${root}.`)) {
            const field = p.slice(root.length + 1).split(/[.[]/)[0] as string;
            expect(RESPONSE_FIELDS.has(field), `${p} reads past the response envelope`).toBe(true);
          }
        }
      }
    });

    it('names only seeded agents', () => {
      const seeded = readFileSync(SYNC_BUILTINS, 'utf8');
      for (const node of Object.values(starter.spec.nodes)) {
        if (node.type === 'agent') {
          expect(seeded, `agent '${node.agentRef}'`).toContain(`key: '${node.agentRef}'`);
        }
      }
    });
  });

  it('covers every node type except the documented exclusions', () => {
    const covered = new Set(STARTER_TEMPLATES.flatMap((s) => s.teaches));
    const types = NodeSchema.options.map((o) => o.shape.type.value as string);
    const missing = types.filter((t) => !covered.has(t as never) && !EXCLUDED.has(t));
    expect(missing).toEqual([]);
  });
});
