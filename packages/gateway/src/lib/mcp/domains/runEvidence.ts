import { z } from 'zod';
import { count, shortName, status, timestamp } from '../projections.js';
import { pageInput, query, type ToolKit } from '../toolKit.js';
import type { McpDomain } from './index.js';

/**
 * Run evidence: what a run measured, changed and decided, and which captures it holds. Everything
 * an agent or a person wrote into these records is free text and is never returned: eval
 * rationales and metadata, an effect's action, target, detail and error, a decision's payload, an
 * evidence item's caption, page URL, source and content type. What is left is identifiers, enums,
 * numbers, flags, timestamps and the few short names a workflow author gives a node or an agent.
 */

/** The prefix `runEvalNode` writes on a placeholder score; inlined because MCP code imports no shared module. */
const SCORER_ERROR_PREFIX = 'scorer error: ';
const nodeId = shortName(100).nullable();
const agentKey = shortName(100).nullable();
const evidenceKind = z.enum(['screenshot', 'video', 'trace', 'log']);
const effectVia = z.enum(['harness_relay', 'mastra_mcp', 'activity', 'unknown']).catch('unknown');
const DECISION_EVENTS = [
  'publish',
  'approve',
  'reject',
  'approve_partial',
  'request_changes',
  'select',
  'submit',
] as const;
const decisionEvent = z.enum([...DECISION_EVENTS, 'unknown']).catch('unknown');
const nullableInt = z.number().int().nullable();

const runIdInput = { runId: z.string().uuid().describe('The workflow run id') };

const restEvalResults = z.object({
  data: z.array(
    z.object({
      agentKey,
      createdAt: timestamp,
      id: z.string().uuid(),
      nodeId,
      passed: z.boolean().nullable(),
      // Read only to say whether the scorer ran; the text itself is never returned.
      rationale: z.string().nullable().optional(),
      scorer: shortName(100),
      scoreType: status,
      source: status,
      value: z.number().finite(),
    })
  ),
});

const restEffects = z.object({
  data: z.array(
    z.object({
      agentKey,
      createdAt: timestamp,
      id: z.string().uuid(),
      kind: status,
      specNodeId: nodeId,
      status,
      via: effectVia,
    })
  ),
  truncated: z.boolean(),
});

const restDecisions = z.object({
  data: z.array(
    z.object({
      actorId: z.string().uuid().nullable(),
      createdAt: timestamp,
      event: decisionEvent,
      id: z.string().uuid(),
      policyName: shortName(100).nullable(),
      requiredApprovers: count.nullable(),
      riskClass: shortName(64).nullable(),
    })
  ),
});

const restEvidence = z.object({
  data: z.array(
    z.object({
      createdAt: timestamp,
      height: nullableInt,
      id: z.string().uuid(),
      kind: evidenceKind,
      sizeBytes: count,
      specNodeId: nodeId,
      stepAttempt: nullableInt,
      width: nullableInt,
    })
  ),
});

const evalResultsOutput = z.object({
  results: z.array(
    z.object({
      agentKey: z.string().nullable(),
      createdAt: z.string(),
      id: z.string().uuid(),
      nodeId: z.string().nullable(),
      passed: z.boolean().nullable(),
      /** False when the scorer did not run, so `value` is a placeholder and not a measurement. */
      scored: z.boolean(),
      scorer: z.string(),
      scoreType: z.string(),
      source: z.string(),
      value: z.number(),
    })
  ),
});

const effectsOutput = z.object({
  effects: z.array(
    z.object({
      agentKey: z.string().nullable(),
      createdAt: z.string(),
      id: z.string().uuid(),
      kind: z.string(),
      nodeId: z.string().nullable(),
      status: z.string(),
      via: z.enum(['harness_relay', 'mastra_mcp', 'activity', 'unknown']),
    })
  ),
  truncated: z.boolean(),
});

const decisionsOutput = z.object({
  decisions: z.array(
    z.object({
      actorId: z.string().uuid().nullable(),
      createdAt: z.string(),
      event: z.enum([...DECISION_EVENTS, 'unknown']),
      id: z.string().uuid(),
      policyName: z.string().nullable(),
      requiredApprovers: z.number().int().nullable(),
      riskClass: z.string().nullable(),
    })
  ),
});

const evidenceOutput = z.object({
  evidence: z.array(
    z.object({
      createdAt: z.string(),
      height: z.number().int().nullable(),
      id: z.string().uuid(),
      kind: evidenceKind,
      nodeId: z.string().nullable(),
      sizeBytes: z.number().int(),
      stepAttempt: z.number().int().nullable(),
      width: z.number().int().nullable(),
    })
  ),
});

const RUN_NOT_FOUND = 'Run not found.';

export const runEvidenceDomain: McpDomain = {
  name: 'runEvidence',
  register({ get, readTool }: ToolKit) {
    readTool(
      'get_run_eval_results',
      {
        description:
          'Get the eval signals captured for one run, oldest first: which scorer, which step and agent, the score (0 to 1), whether it passed, and `scored`, which is false when the scorer did not run and the score is a placeholder. Rationales and metadata are not returned.',
        input: runIdInput,
        notFound: RUN_NOT_FOUND,
        output: evalResultsOutput,
        title: 'Get a run’s eval results',
      },
      (args) => get(`/api/v1/workflow-runs/${args.runId}/eval-results`),
      (body) => {
        const parsed = restEvalResults.safeParse(body);
        return parsed.success
          ? {
              results: parsed.data.data.map((r) => ({
                agentKey: r.agentKey,
                createdAt: r.createdAt,
                id: r.id,
                nodeId: r.nodeId,
                passed: r.passed,
                scored: !r.rationale?.startsWith(SCORER_ERROR_PREFIX),
                scorer: r.scorer,
                scoreType: r.scoreType,
                source: r.source,
                value: r.value,
              })),
            }
          : null;
      }
    );

    readTool(
      'list_run_effects',
      {
        description:
          'List what one run changed outside its sandbox, oldest first: the kind of effect (pull request, git push, tracker, knowledge base, MCP tool), whether it succeeded, the step and agent. Targets, details and errors are not returned. `truncated` means older effects were cut.',
        input: runIdInput,
        notFound: RUN_NOT_FOUND,
        output: effectsOutput,
        title: 'List a run’s external effects',
      },
      (args) => get(`/api/v1/workflow-runs/${args.runId}/effects`),
      (body) => {
        const parsed = restEffects.safeParse(body);
        return parsed.success
          ? {
              effects: parsed.data.data.map((e) => ({
                agentKey: e.agentKey,
                createdAt: e.createdAt,
                id: e.id,
                kind: e.kind,
                nodeId: e.specNodeId,
                status: e.status,
                via: e.via,
              })),
              truncated: parsed.data.truncated,
            }
          : null;
      }
    );

    readTool(
      'list_run_autonomy_decisions',
      {
        description:
          'List the governance audit trail of one run, oldest first: publish, approve, reject, request-changes, select and submit events with the acting user id, policy name, risk class and required approver count. Decision payloads are not returned.',
        input: { ...runIdInput, ...pageInput },
        notFound: RUN_NOT_FOUND,
        output: decisionsOutput,
        title: 'List a run’s autonomy decisions',
      },
      (args) =>
        get(
          `/api/v1/workflow-runs/${args.runId}/autonomy-decisions`,
          query({ limit: args.limit ?? 50, offset: args.offset })
        ),
      (body) => {
        const parsed = restDecisions.safeParse(body);
        return parsed.success
          ? {
              decisions: parsed.data.data.map((d) => ({
                actorId: d.actorId,
                createdAt: d.createdAt,
                event: d.event,
                id: d.id,
                policyName: d.policyName,
                requiredApprovers: d.requiredApprovers,
                riskClass: d.riskClass,
              })),
            }
          : null;
      }
    );

    readTool(
      'list_run_evidence',
      {
        description:
          'List the UI evidence captured for one run, oldest first: id, kind (screenshot, video, trace, log), size, dimensions, the step and attempt, and when. Metadata only; the content, links and captions are not returned.',
        input: runIdInput,
        notFound: RUN_NOT_FOUND,
        output: evidenceOutput,
        title: 'List a run’s evidence',
      },
      (args) => get(`/api/v1/workflow-runs/${args.runId}/evidence`),
      (body) => {
        const parsed = restEvidence.safeParse(body);
        return parsed.success
          ? {
              evidence: parsed.data.data.map((e) => ({
                createdAt: e.createdAt,
                height: e.height,
                id: e.id,
                kind: e.kind,
                nodeId: e.specNodeId,
                sizeBytes: e.sizeBytes,
                stepAttempt: e.stepAttempt,
                width: e.width,
              })),
            }
          : null;
      }
    );
  },
  tools: [
    {
      name: 'get_run_eval_results',
      route: 'GET /api/v1/workflow-runs/:id/eval-results',
      tier: 'user',
    },
    { name: 'list_run_effects', route: 'GET /api/v1/workflow-runs/:id/effects', tier: 'user' },
    {
      name: 'list_run_autonomy_decisions',
      route: 'GET /api/v1/workflow-runs/:id/autonomy-decisions',
      tier: 'user',
    },
    { name: 'list_run_evidence', route: 'GET /api/v1/workflow-runs/:id/evidence', tier: 'user' },
  ],
};
