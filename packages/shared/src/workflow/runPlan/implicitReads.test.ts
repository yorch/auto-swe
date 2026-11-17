/**
 * Implicit context reads: places the worker reads a context path that no node `inputs` binding
 * names. The core's inputs are pinned, so a free node cannot rebind them; an implicit read is the
 * other road in: `ticketFromStep` falls back to `context.ticket`, the review falls back to
 * `context.successCriteria`, a step takes `context.workspace` for its connection, a fan-out
 * branch's step takes the top-level `subtask`. Each one is only safe because the policy refuses
 * every free write to the path it reads, or admits it from a platform step alone.
 *
 * The test greps the worker's source for such reads and fails on one it does not know, so a new
 * fallback cannot land without someone writing down which rule guards it. Then it drives every
 * known one through the full policy and requires the hostile write to be refused.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalDeliveringRaw, clone, parse, type RawSpec } from './skeletonFixtures.js';
import { checkSkeletonPolicy } from './skeletonPolicy.js';

const WORKER_SRC = fileURLToPath(new URL('../../../../worker/src/', import.meta.url));

type Guard =
  /** Only a platform step's named field may fill it (`DERIVED_PATHS` in skeletonBindings.ts). */
  | 'derived-platform-step'
  /** Nothing a generated plan may write fills it (no entry in `DERIVED_PATHS`). */
  | 'unwritable'
  /** Outside `context.`, which a generated plan may not write at all (`RESERVED_PATH_WRITE`). */
  | 'outside-context';

/** Every implicit read the worker makes, and the rule that guards it. */
const IMPLICIT_READS: Readonly<Record<string, { guard: Guard; reader: string }>> = {
  'context.ciTriage': { guard: 'unwritable', reader: 'CI and PR-feedback steps' },
  'context.currentCodeResult': { guard: 'derived-platform-step', reader: 'pickCodeResult' },
  'context.currentCodeResult.baseSha': { guard: 'derived-platform-step', reader: 'review' },
  'context.currentCodeResult.branch': { guard: 'derived-platform-step', reader: 'gates, PR, CI' },
  'context.currentCodeResult.headSha': { guard: 'derived-platform-step', reader: 'review' },
  'context.lastCILogs': { guard: 'derived-platform-step', reader: 'executeCIFixImplementation' },
  'context.lastGateOutput': { guard: 'derived-platform-step', reader: 'gate fix' },
  'context.lastRejectionSummary': { guard: 'derived-platform-step', reader: 'review fix' },
  'context.prFeedback': { guard: 'unwritable', reader: 'PR-feedback steps' },
  'context.pushedCommitSha': { guard: 'unwritable', reader: 'PR-feedback steps' },
  'context.successCriteria': { guard: 'derived-platform-step', reader: 'runReviewNetwork' },
  'context.ticket': { guard: 'derived-platform-step', reader: 'ticketFromStep' },
  'context.workspace': { guard: 'unwritable', reader: 'step connection and workspace provider' },
  'fanOut.itemKey': { guard: 'outside-context', reader: 'fan-out subtask lookup' },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Context paths the worker reads without an input binding, with the files that read them. */
function observedReads(): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  const note = (path: string, file: string): void => {
    found.set(path, (found.get(path) ?? new Set()).add(file.slice(WORKER_SRC.length)));
  };
  for (const file of sourceFiles(WORKER_SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/lookupPath\(\s*\w+\s*,\s*'([^']+)'\s*\)/g)) {
      note(m[1] as string, file);
    }
    // `(ctx.context as Record<string, unknown>).workspace`
    for (const m of text.matchAll(/\(ctx\.context as Record<string, unknown>\)\s*\.(\w+)/g)) {
      note(`context.${m[1]}`, file);
    }
    for (const m of text.matchAll(/\bctx\.context\??\.(\w+)/g)) {
      note(`context.${m[1]}`, file);
    }
  }
  return new Map([...found].map(([path, files]) => [path, [...files].sort()]));
}

describe('implicit context reads in the worker', () => {
  const observed = observedReads();

  it('finds the reads this test was written against (the grep still works)', () => {
    expect(observed.get('context.ticket')).toEqual(['workflows/runnableSteps.ts']);
    expect(observed.get('context.successCriteria')).toEqual(['workflows/runnableSteps.ts']);
    expect(observed.get('context.workspace')).toContain('workflows/runnableSteps.ts');
  });

  it('knows a guard for every one, so a new fallback cannot land unreviewed', () => {
    const unknown = [...observed.keys()].filter((p) => !Object.hasOwn(IMPLICIT_READS, p));
    expect(
      unknown,
      `the worker reads ${unknown.map((p) => `'${p}' (${observed.get(p)?.join(', ')})`).join('; ')} without an input binding. ` +
        'Decide which rule of the skeleton policy stops a generated plan from writing it, add a test here, and list it in IMPLICIT_READS.'
    ).toEqual([]);
  });

  it('keeps the top-level subtask default the fan-out lookup relies on', () => {
    const text = readFileSync(join(WORKER_SRC, 'workflows/runnableSteps.ts'), 'utf8');
    expect(text).toMatch(/lookupPath\(ctx, 'fanOut\.itemKey'\)[^;]*\?\? 'subtask'/);
  });

  const hostile = (path: string, value: Record<string, unknown>): RawSpec => {
    const raw = canonicalDeliveringRaw();
    raw.nodes.research = { ...raw.nodes.research, next: 'poke' };
    raw.nodes.poke = { next: 'gatherTicket', type: 'set', values: { [path]: value } };
    return raw;
  };
  const codes = (raw: RawSpec): string[] =>
    checkSkeletonPolicy(parse(clone(raw)), 'delivering').errors.map((e) => e.code);

  describe.each(Object.entries(IMPLICIT_READS))('%s', (path, { guard }) => {
    const refused =
      guard === 'outside-context'
        ? ['RESERVED_PATH_WRITE']
        : ['CODE_RESULT_FORGED', 'CONTEXT_WRITE_DENIED'];

    it('refuses a literal written to it by a free node', () => {
      expect(
        codes(hostile(path, { literal: 'attacker' })).filter((c) => refused.includes(c))
      ).not.toEqual([]);
    });

    it('refuses text an agent wrote, copied or stored into it', () => {
      const copied = hostile(path, { from: 'nodes.research.output' });
      expect(codes(copied).filter((c) => refused.includes(c))).not.toEqual([]);
      const stored = canonicalDeliveringRaw();
      stored.nodes.research = { ...stored.nodes.research, storeAs: path };
      expect(codes(stored).filter((c) => refused.includes(c))).not.toEqual([]);
    });

    it('refuses an expression written to it', () => {
      expect(
        codes(hostile(path, { expr: "'attacker'" })).filter((c) => refused.includes(c))
      ).not.toEqual([]);
    });
  });

  it('lets the platform step fill the two paths a fallback reads (positive controls)', () => {
    // The shipped validate phase gathers the ticket into context.ticket and copies the criteria
    // out of validateContext's output into context.successCriteria.
    const raw = canonicalDeliveringRaw();
    expect(codes(raw)).toEqual([]);
  });
});
