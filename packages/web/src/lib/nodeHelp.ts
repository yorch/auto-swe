import type { Node as SpecNode } from '@auto-swe/shared/workflow';
import { CONTAINER_AUTHORING_RULE } from '@/components/workflow/containerNodes';
import { HELP_LINKS } from './helpLinks';

/**
 * Plain-language help for each workflow node type, shown in the editor's inspector and palette.
 * Every claim here is written against `packages/shared/src/workflow` (spec.ts, expr.ts,
 * interpreter.ts); `nodeHelp.test.ts` checks that each node type has an entry and that each
 * example parses with the real node schema (and, for `cond`, the real expression evaluator).
 * Keyed as a `Record` over the node union so a new node type is a compile error until documented.
 */
export type NodeHelp = {
  /** What the node does, in one or two sentences. */
  what: string;
  /** When to reach for it. */
  when: string;
  /** The field or behaviour that trips people up. */
  gotcha: string;
  /** A small node, as it appears in the workflow JSON. Parsed by the real node schema in tests. */
  example: object;
  /** For `cond`: the expression on its own, evaluated by the real evaluator in tests. */
  expressionExample?: string;
  /** Where the docs cover it. */
  doc: { slug: string; anchor?: string };
};

const NODE_DOC = HELP_LINKS.architectureNodeTypes;
const HUMAN_DOC = HELP_LINKS.approvals;

export const NODE_HELP: Record<SpecNode['type'], NodeHelp> = {
  agent: {
    doc: NODE_DOC,
    example: {
      agentRef: 'planner',
      inputs: { goal: { from: 'request.description' } },
      next: 'review',
      type: 'agent',
    },
    gotcha:
      '`agentRef` is a library Agent key. A bare key follows the latest version; `key@3` pins version 3. Saving warns when no active Agent has that key, but does not block the save.',
    what: 'Runs an Agent from the library. Its output is recorded at nodes.<id>.output for later nodes to read.',
    when: 'You want a model to do a piece of work and hand a result to the next node. Turn on "workspace" to give it a throwaway checkout of the run’s repository; a run with no repository fails that node.',
  },
  cond: {
    doc: NODE_DOC,
    example: {
      expr: '(context.attempts ?? 0) < 3 && nodes.review.output.approved != true',
      onFalse: 'giveUp',
      onTrue: 'fixAgain',
      type: 'cond',
    },
    expressionExample: '(context.attempts ?? 0) < 3 && nodes.review.output.approved != true',
    gotcha:
      'The expression language is small: paths, numbers, quoted strings, true/false/null, + - * /, == != < <= > >=, && || !, ?? and parentheses. No function calls. Ordering (< <= > >=) and arithmetic need numbers and raise an error at run time otherwise; == and != compare strictly. A path that does not exist reads as missing, and a missing value fails ordering: use ?? to give it a default, as in (a.count ?? 0) > 0. A guard such as a != null does not help when a is absent, because != is strict.',
    what: 'Sends the run down one of two edges depending on whether an expression is true.',
    when: 'You need an if/else, such as retry until a counter is reached, or take a different path after a review.',
  },
  containerStep: {
    doc: NODE_DOC,
    example: {
      command: 'node -e "console.log(JSON.stringify({ ok: true }))"',
      image: 'node:24-alpine',
      inputs: { repo: { from: 'request.repoName' } },
      next: 'done',
      type: 'containerStep',
    },
    gotcha: `The container gets its inputs as JSON in the CONTAINER_STEP_INPUT environment variable and must print one JSON object to stdout (the default transport). The result lands at nodes.<id>.output.result. The image must be on the team’s allowlist. The network is off unless you set network to egress (the sidecar transport is the exception: it uses bridge networking). ${CONTAINER_AUTHORING_RULE}`,
    what: 'Runs an image in a locked-down, throwaway container with a JSON-in, JSON-out contract.',
    when: 'You have a coded capability that no built-in step offers and you can package it as an image.',
  },
  eval: {
    doc: HELP_LINKS.evals,
    example: {
      next: 'decide',
      // `decide` routes on the result, so a blocked eval must carry on rather than fail the run.
      onFail: 'warn',
      scorers: [{ expr: '$.approved == true', kind: 'assert' }],
      target: { from: 'nodes.review.output' },
      type: 'eval',
    },
    gotcha:
      '`target` is a binding to the value being scored, so an empty path scores nothing useful. Gate, assert, policy and pii scorers always block: they run first and stop the judge if they fail. A judge is advisory unless you set judgeAdvisory to false, which makes only the judge blocking — and then a judge that cannot score (missing rubric, failed call) blocks too; trajectory is always advisory. A blocked eval goes through onFail like a failed gate: block (the default) fails the run, warn carries on. A `gate` scorer does not read `target`: it re-runs the named check on the work request’s pushed branch, and fails when the run has none. The aggregate is at nodes.<id>.output.score.',
    what: 'Scores a value that is already in the run with one or more scorers, then records the result.',
    when: 'You want a measured pass/fail or score to gate the run on, or to branch on with a cond after it (then set onFail to warn).',
  },
  fanOut: {
    doc: NODE_DOC,
    example: {
      concurrency: 4,
      itemKey: 'subtask',
      join: 'collect',
      onBranchFail: 'block',
      over: { from: 'context.subtasks' },
      subgraph: 'runSubtask',
      type: 'fanOut',
    },
    gotcha:
      '`over` must resolve to an array. Each branch runs in its own sealed copy of the context: it sees the parent’s context, request and workflow, and its writes stay in the branch. The parent’s nodes.<id>.output values are not visible inside a branch. The item is at the name you set in itemKey and its position at that name plus Index (subtaskIndex). Only the branch result (and any `exports` paths you list) comes back, under nodes.<id>.output. A terminate node inside a branch ends that branch, not the run.',
    what: 'Runs a sub-flow once for each item of an array, in parallel, then continues at the join node.',
    when: 'The same work repeats over a list, such as one review per changed file or one task per repository.',
  },
  humanApproval: {
    doc: HUMAN_DOC,
    example: {
      onApprove: 'ship',
      onReject: 'stop',
      onTimeout: 'stop',
      timeout: '24h',
      title: 'Approve the plan',
      type: 'humanApproval',
    },
    gotcha:
      '`timeout` is required and so is the onTimeout edge. When time runs out the pending inbox item is marked timed out and the run follows onTimeout; nobody approved. The title is the heading the approver sees.',
    what: 'Pauses the run until a person approves or rejects in the inbox, then follows the matching edge.',
    when: 'A yes/no human decision must come before the next step.',
  },
  humanDecision: {
    doc: HUMAN_DOC,
    example: {
      onTimeout: 'safeDefault',
      options: [
        { label: 'Apply the notes', next: 'apply', value: 'apply' },
        { label: 'Skip them', next: 'skip', value: 'skip' },
      ],
      timeout: '30m',
      title: 'Apply the reviewer notes?',
      type: 'humanDecision',
    },
    gotcha:
      'Needs 2 to 10 options, and each option carries its own edge (`next`). The onTimeout edge is also taken when the answer is not one of the option values. The response is stored at nodes.<id>.output, and at `storeAs` if set.',
    what: 'Pauses the run for a person to pick one option, then follows that option’s edge.',
    when: 'The next step is a choice among a few paths that a model should not make alone.',
  },
  humanInput: {
    doc: HUMAN_DOC,
    example: {
      fields: [
        {
          key: 'environment',
          label: 'Environment',
          options: ['staging', 'production'],
          required: true,
          type: 'select',
        },
        { key: 'version', label: 'Version tag', type: 'text' },
      ],
      onSubmit: 'deploy',
      onTimeout: 'stop',
      storeAs: 'context.deployConfig',
      timeout: '1h',
      title: 'Deployment settings',
      type: 'humanInput',
    },
    gotcha:
      'Field types are text, number, boolean and select; `options` only applies to select. The response is stored whole at nodes.<id>.output (and at `storeAs` if set), with the submitted values in its `value` field.',
    what: 'Pauses the run to collect a small typed form (1 to 20 fields) from a person.',
    when: 'A later node needs values only a person can supply.',
  },
  humanReview: {
    doc: HUMAN_DOC,
    example: {
      contentFrom: 'nodes.implement.output.diff',
      onSubmit: 'next',
      onTimeout: 'next',
      storeAs: 'context.reviewNotes',
      timeout: '8h',
      title: 'Review the diff',
      type: 'humanReview',
    },
    gotcha:
      '`contentFrom` is a path into the run (for example nodes.implement.output.diff), not the text itself. There is one outgoing edge for a submitted review and one for a timeout.',
    what: 'Shows content to a person, who reads it and submits their notes, then continues.',
    when: 'A person should read something the run produced, such as a diff or a draft, and leave feedback.',
  },
  mcp: {
    doc: NODE_DOC,
    example: {
      connectionRef: '00000000-0000-4000-8000-000000000000',
      inputs: { query: { literal: 'open incidents' } },
      next: 'summarise',
      tool: 'search',
      type: 'mcp',
    },
    gotcha:
      '`connectionRef` is the id of an MCP connection, not its name. Saving warns when it does not match an active MCP connection. The tool result is at nodes.<id>.output.result.',
    what: 'Calls one named tool on an MCP server you have connected, with inputs from the run.',
    when: 'You need a single call to an external tool server without going through an agent.',
  },
  set: {
    doc: NODE_DOC,
    example: {
      next: 'check',
      type: 'set',
      values: { 'context.attempts': { expr: '(context.attempts ?? 0) + 1' } },
    },
    gotcha:
      'Each value is a binding object, not a bare value: { "literal": 3 }, { "from": "path" } or { "expr": "a + 1" }. The key is the path to write, such as context.attempts.',
    what: 'Writes values into the run context for later nodes to read. It calls nothing external.',
    when: 'You need a counter, a flag or a renamed value between two other nodes.',
  },
  shell: {
    doc: NODE_DOC,
    example: {
      command: 'node --version',
      image: 'node:24-alpine',
      network: 'none',
      next: 'next',
      timeoutMs: 120000,
      type: 'shell',
    },
    gotcha: `The image must be on the team’s allowlist. The container has no network unless you set network to egress, a read-only root filesystem (only /workspace and /tmp are writable) and no Docker socket. ${CONTAINER_AUTHORING_RULE} A result with passed=false is handled by onFail.`,
    what: 'Runs one command in a throwaway, locked-down container.',
    when: 'You need a tool or script that no built-in step provides and can run in a stock image.',
  },
  signal: {
    doc: NODE_DOC,
    example: {
      name: 'humanMergeSignal',
      onReceive: 'afterMerge',
      onTimeout: 'giveUp',
      storeAs: 'context.mergeSignal',
      timeout: '7d',
      type: 'signal',
    },
    gotcha:
      'It waits for a Temporal signal with exactly this `name`, sent to the run by something outside the workflow. The editor cannot check that anything will send it; if nothing does, the wait runs out and follows onTimeout. A signal that arrives before the node is reached is kept for it. The timeout is a duration such as 30m, 24h or 7d.',
    what: 'Waits for a named signal from outside, or for a timeout, and routes on which happens first.',
    when: 'The run must park until an external event, such as a merge webhook, arrives.',
  },
  step: {
    doc: NODE_DOC,
    example: { inputs: {}, next: 'review', onFail: { retry: 2 }, step: 'runTests', type: 'step' },
    gotcha:
      '`step` must name a registered step (pick one from the palette). Internal platform steps are not allowed in authored workflows. A step that reports passed=false is handled by onFail: block, warn, or { retry: N } for N more attempts.',
    what: 'Runs one registered step, such as a test or lint gate, with inputs from the run.',
    when: 'The platform already has a step for what you need.',
  },
  terminate: {
    doc: NODE_DOC,
    example: { status: 'SUCCESS', type: 'terminate' },
    gotcha:
      'Status is SUCCESS, FAILED, TIMED_OUT or SKIPPED; a run cannot be ended as CANCELLED from here. Inside a fan-out branch a terminate ends only that branch. A workflow with no terminate node reachable from its first step is a validation error.',
    what: 'Ends the run with a status and an optional result.',
    when: 'At the end of every path, so each branch finishes with an explicit outcome.',
  },
};

export function nodeHelp(type: SpecNode['type']): NodeHelp {
  return NODE_HELP[type];
}
