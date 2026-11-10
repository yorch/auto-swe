import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Node, parseWorkflowSpec, type WorkflowSpec } from '../spec.js';
import { BUILTIN_TEMPLATES } from './index.js';

/**
 * Golden check for the built-in templates.
 *
 * `__golden__/<name>.json` is each template's FLAT spec as it was seeded before
 * the templates were rewritten on top of the authoring helpers
 * (`authoring/`). The helpers expand at module load into plain nodes, so what
 * the engine, a run snapshot, template analytics and a bundle hash see must not
 * move: the built spec has to equal its golden, node for node and id for id.
 *
 * The ONLY permitted differences are the entries in {@link INTENDED_CHANGES}
 * below, each with its reason, plus the presentation fields (`group`, and
 * `title` where a node has no inbox title) the helpers add and this test
 * strips before comparing.
 */

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__golden__');
/**
 * Reviewed snapshots of the templates rewritten on the node fields `status`, `storeAs`,
 * `onFailure` and `maxVisits`. The files beside them are the previous release's specs (the
 * syncBuiltins rollout test seeds from them), so they are left as they were.
 * `UPDATE_SUGAR_GOLDEN=1 yarn vitest run packages/shared/src/workflow/templates/golden.test.ts`
 * rewrites these snapshots; read the diff before committing it.
 */
const SUGAR_DIR = path.join(GOLDEN_DIR, 'sugar');

function golden(name: string): WorkflowSpec {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as WorkflowSpec;
}

function sugarGolden(name: string): WorkflowSpec {
  return JSON.parse(readFileSync(path.join(SUGAR_DIR, `${name}.json`), 'utf8')) as WorkflowSpec;
}

/** Drop `group`, and `title` on every node type that did not already have one. */
function stripPresentation(spec: WorkflowSpec): WorkflowSpec {
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const { group: _group, ...rest } = node as Node & { group?: string };
    if (node.type.startsWith('human')) {
      nodes[id] = rest as Node;
    } else {
      const { title: _title, ...noTitle } = rest as Node & { title?: string };
      nodes[id] = noTitle as Node;
    }
  }
  return { ...spec, nodes };
}

/** Remove a pass-through node, pointing everything that targeted it at its `next`. */
function removePassThrough(spec: WorkflowSpec, id: string): WorkflowSpec {
  const removed = spec.nodes[id] as Node & { next?: string };
  const to = removed.next as string;
  const retarget = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(retarget);
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, retarget(x)]));
    }
    return v === id ? to : v;
  };
  const nodes: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    if (nodeId !== id) {
      nodes[nodeId] = retarget(node);
    }
  }
  return {
    ...spec,
    entry: spec.entry === id ? to : spec.entry,
    nodes: nodes as WorkflowSpec['nodes'],
  };
}

/**
 * `notion-content-draft` appends to the operator's own Notion page through the same policy gate
 * its sibling `notion-content-brand-review` uses: `publishOutcome` declares the class
 * (`internal_write`), `checkAuto` branches on the decision, and a required approval waits on
 * `humanApproval` before the write, with `doneRejected` when it is refused or times out.
 */
function withNotionDraftPolicyGate(g: WorkflowSpec): WorkflowSpec {
  const nodes = structuredClone(g.nodes) as Record<string, Record<string, unknown>>;
  nodes.draftContent = { ...(nodes.draftContent as object), next: 'publishOutcome' };
  nodes.publishOutcome = {
    config: { action: 'internal_write' },
    inputs: { description: { from: 'request.payload.instructions' } },
    next: 'checkAuto',
    step: 'publishOutcome',
    type: 'step',
  };
  nodes.checkAuto = {
    expr: "nodes.publishOutcome.output.decision == 'require_approval'",
    onFalse: 'writeOutcome',
    onTrue: 'humanApproval',
    type: 'cond',
  };
  nodes.humanApproval = {
    approverCount: { from: 'nodes.publishOutcome.output.approverCount' },
    contextFrom: 'nodes.draftContent.output.text',
    description: 'Approve appending the draft to the target Notion page, or reject to discard it.',
    onApprove: 'writeOutcome',
    onReject: 'doneRejected',
    onTimeout: 'doneRejected',
    timeout: '24h',
    title: 'Approve write',
    type: 'humanApproval',
  };
  nodes.doneRejected = {
    result: {
      approved: { literal: false },
      targetPageId: { from: 'request.payload.targetPageId' },
      written: { literal: false },
    },
    status: 'SUCCESS',
    type: 'terminate',
  };
  return { ...g, nodes } as WorkflowSpec;
}

const SUGAR_REASON =
  'plumbing removed by status/storeAs/onFailure/maxVisits: status stamps, copy-out sets, ' +
  'failure ladders and retry counters are fields on the node they belonged to';

const FINALIZER = 'the finalizer already writes COMPLETED on SUCCESS';
const LESSONS =
  'a review or CI loop that runs out of attempts stores a lesson about what blocked it ' +
  'before the run fails';
const STALL =
  'the review loop stops when two consecutive rejected reviews carry the same findings, ' +
  'going where running out of attempts goes; an approval clears the remembered findings first';
const CI_FIRST =
  'CI (with a 2-attempt fix loop) runs before the final gate and a rejection goes fix -> CI -> ' +
  'gate again';
const TICKET_HEAD =
  'the run’s tracker ticket is gathered before validation and handed to validate and implement, ' +
  'a request validation finds not actionable ends the run FAILED before implement, and ' +
  'implement receives validate’s success criteria';

/**
 * The templates held to a sugar snapshot, with what changed in them before the sugar did
 * (the history is only text; the snapshot is what the build is held to).
 */
const SUGARED: Record<string, string> = {
  'address-pr-feedback': '',
  'agent-reviewed-pr': `${FINALIZER}; ${LESSONS}; ${STALL};`,
  'approve-before-pr':
    `${FINALIZER}; the gate offers request changes, a fix that is re-tested before the gate, ` +
    'and a third request fails the run;',
  'ci-triage-and-fix':
    'a fix is checked against the failing step’s own command before it is delivered; a fix ' +
    'pushed onto a pull request has its CI watched, with one follow-up attempt;',
  'code-and-ci': `${FINALIZER}; ${LESSONS};`,
  'consensus-review': `${FINALIZER}; ${CI_FIRST}; ${LESSONS}; ${STALL};`,
  'db-migration-dry-run': '',
  'dependency-update': `${FINALIZER}; ${LESSONS};`,
  'docs-refresh': 'the description names the markdown prompt and the docs-directory path guard;',
  'external-approval-gate': `${STALL};`,
  'four-eyes': `${FINALIZER}; ${CI_FIRST}; ${LESSONS} (not for the sign-off loop); ${STALL};`,
  'fully-supervised': 'the final approval offers request changes, capped at three rounds;',
  hotfix: '',
  'human-code-review': '',
  'model-catalog-refresh': `the guidance carries price-list figures, checked in code after the review; ${STALL};`,
  'parallel-fan-out': '',
  'prd-decomposition': '',
  'scope-clarification': `${STALL};`,
  'security-triage': '',
  'staged-deploy-signals': `${STALL};`,
  'ticket-to-merge': `${FINALIZER}; ${LESSONS}; ${TICKET_HEAD}; ${STALL};`,
  'ticket-to-merge-qodo': `${TICKET_HEAD}; ${STALL};`,
  'tiered-escalation': '',
  'vulnerability-remediation': '',
};

/** Deliberate departures from the golden, keyed by template name. Anything not listed must match. */
const INTENDED_CHANGES: Record<
  string,
  { reason: string; apply: (g: WorkflowSpec) => WorkflowSpec }
> = {
  'notion-content-draft': {
    apply: withNotionDraftPolicyGate,
    reason:
      'the paragraph it appends is an internal write, so the template records the autonomy ' +
      'decision the audit log and any later policy edit are held to, and waits for approval when ' +
      'the policy asks for one, exactly as its brand-review sibling does',
  },
  // `writes: 'split'` names the two write nodes autoWrite/manualWrite, so the
  // result's `nodes.writeOutcome` reference pointed at a node that never runs.
  ...Object.fromEntries(
    ['create-issue', 'create-issue-from-brief'].map((name) => [
      name,
      {
        apply: (g: WorkflowSpec) => issueUrlFromSplitWrites(g),
        reason: 'the issue URL is read from whichever split write node ran',
      },
    ])
  ),
  ...Object.fromEntries(
    Object.entries(SUGARED).map(([name, history]) => [
      name,
      {
        // The previous release's spec differs from today's by more than this test can express
        // as edits (the plumbing nodes are gone and their ids with them), so the target is the
        // reviewed snapshot in `__golden__/sugar/`.
        apply: () => sugarGolden(name),
        reason: history ? `${history} ${SUGAR_REASON}` : SUGAR_REASON,
      },
    ])
  ),
};

/** Point `done`'s issueUrl at the split write nodes instead of the absent `writeOutcome`. */
function issueUrlFromSplitWrites(spec: WorkflowSpec): WorkflowSpec {
  const done = structuredClone(spec.nodes.done) as Node & { result: Record<string, unknown> };
  done.result.issueUrl = {
    expr: 'nodes.autoWrite.output.reference ?? nodes.manualWrite.output.reference',
  };
  return { ...spec, nodes: { ...spec.nodes, done } };
}

describe('built-in templates match their pre-helper golden specs', () => {
  it('has a golden file for every built-in template, and no stray ones', () => {
    const files = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual(BUILTIN_TEMPLATES.map((t) => t.name).sort());
  });

  it('has a sugar snapshot for exactly the templates that name one', () => {
    if (process.env.UPDATE_SUGAR_GOLDEN === '1') {
      return;
    }
    const files = readdirSync(SUGAR_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual(Object.keys(SUGARED).sort());
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.name, t.spec] as const))(
    '%s expands to its golden flat spec',
    (name, spec) => {
      const built = stripPresentation(spec);
      if (process.env.UPDATE_SUGAR_GOLDEN === '1' && name in SUGARED) {
        mkdirSync(SUGAR_DIR, { recursive: true });
        writeFileSync(path.join(SUGAR_DIR, `${name}.json`), `${JSON.stringify(built, null, 2)}\n`);
        return;
      }
      const change = INTENDED_CHANGES[name];
      const expected = change ? change.apply(golden(name)) : golden(name);
      // Strict: a key left as `undefined` would pass toEqual but is not the golden's bytes.
      expect(built).toStrictEqual(expected);
    }
  );

  it.each(BUILTIN_TEMPLATES.map((t) => t.name))(
    'the golden for %s is a spec as stored before group/title existed, and still parses',
    (name) => {
      const raw = golden(name);
      const parsed = parseWorkflowSpec(raw);
      expect(Object.keys(parsed.nodes)).toEqual(Object.keys(raw.nodes));
      for (const node of Object.values(raw.nodes)) {
        expect('group' in node).toBe(false);
      }
    }
  );

  it('keeps removePassThrough honest: it retargets every edge and the entry', () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'x',
      nodes: {
        a: { next: 'mid', step: 'runLint', type: 'step' },
        c: { expr: 'x == 1', onFalse: 'mid', onTrue: 'end', type: 'cond' },
        end: { status: 'SUCCESS', type: 'terminate' },
        mid: { next: 'end', step: 'updateDomainState', type: 'step' },
      },
      schemaVersion: 1,
    });
    const out = removePassThrough(spec, 'mid');
    expect(Object.keys(out.nodes)).toEqual(['a', 'c', 'end']);
    expect((out.nodes.a as { next: string }).next).toBe('end');
    expect((out.nodes.c as { onFalse: string }).onFalse).toBe('end');
  });
});
