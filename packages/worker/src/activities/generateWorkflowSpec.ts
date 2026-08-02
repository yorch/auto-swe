/**
 * generateWorkflowSpec — turn a natural-language description into a validated
 * {@link WorkflowSpec}.
 *
 * Runs the seeded `workflowAuthor` agent in a generate → validate → repair loop:
 * the model returns the spec as a JSON string, we `parseWorkflowSpec` it, and on
 * any JSON / schema error we feed the concrete errors back and ask for a fix
 * (bounded by {@link MAX_ATTEMPTS}). The dynamic catalog of building blocks
 * (registered steps + library agents + MCP connections in scope) is rendered
 * into the prompt so the model can only pick real names.
 *
 * This is the worker-side home for the LLM call (the gateway never binds models);
 * the gateway starts {@link WorkflowAuthorWorkflow} and awaits this activity's result.
 */

import { prisma } from '@auto-swe/shared/db';
import {
  type AuthoringCatalog,
  BUILTIN_SHELL_IMAGES,
  buildAuthorRequestMessage,
  buildRefineRequestMessage,
  buildRepairRequestMessage,
  formatValidationIssue,
  parseWorkflowSpec,
  validateSpec,
  type WorkflowAuthorOutput,
  WorkflowAuthorOutputSchema,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { ZodError } from 'zod';
import { resolveAgentSpec } from '../lib/config/agentSpec.js';
import type { ModelBackedAgentKey } from '../lib/config/types.js';
import { runAgent } from './runAgent.js';

export interface GenerateWorkflowSpecInput {
  /**
   * The user's request. For a fresh generation this is a description of the
   * workflow to build; for a refinement (when {@link baseSpec} is set) it's the
   * plain-language change to apply.
   */
  prompt: string;
  /** Team scope for the catalog + agent resolution (null = global/admin). */
  teamId?: string | null;
  /** Whether the requester may author shell / containerStep nodes. */
  allowShell?: boolean;
  /**
   * When set, refine this existing spec instead of generating from scratch: the
   * model is seeded with the current spec and asked to apply `prompt` as a change,
   * preserving everything else. Enables conversational refinement.
   */
  baseSpec?: WorkflowSpec;
}

export interface GenerateWorkflowSpecResult {
  /** The validated spec (already passed `parseWorkflowSpec`). */
  spec: WorkflowSpec;
  /** The model's one- or two-sentence summary of what it built. */
  summary: string;
  /** How many model attempts it took (1 = first try valid). */
  attempts: number;
}

/** Hard cap on generate→repair rounds. Each round is one (costly) LLM call. */
const MAX_ATTEMPTS = 3;

/** Format a thrown validation error into a flat list of human-readable issues. */
function formatErrors(err: unknown): string[] {
  if (err instanceof ZodError) {
    return err.issues.map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    });
  }
  return [err instanceof Error ? err.message : String(err)];
}

/**
 * Build the catalog of building blocks visible to the requester: every library
 * agent at GLOBAL or the requester's team scope, and the team's active `mcp`
 * connections. Registered step names come from the in-process registry (added by
 * the shared catalog renderer), so they are not queried here.
 */
async function buildCatalog(teamId: string | null, allowShell: boolean): Promise<AuthoringCatalog> {
  const agentRows = await prisma.agent.findMany({
    // scope DESC so a TEAM row sorts before the GLOBAL one ('TEAM' > 'GLOBAL'),
    // letting the dedupe below keep the team override's name/description.
    orderBy: [{ key: 'asc' }, { scope: 'desc' }],
    select: { description: true, key: true, name: true },
    where: {
      isActive: true,
      // Only GLOBAL + the requester's TEAM-scoped agents — not ORGANIZATION /
      // CHANNEL / WORKFLOW_TEMPLATE rows that merely carry the same teamId.
      // Both branches name `teamId`, so this stays scoped with or without a
      // team: GLOBAL rows carry none, and a null `teamId` matches no TEAM row.
      OR: [
        { scope: 'GLOBAL' as const, teamId: null },
        { scope: 'TEAM' as const, teamId },
      ],
    },
  });
  // Dedupe by key (a team override + the GLOBAL row share a key) — keep the first
  // seen, which is the TEAM row when present (scope DESC), so the catalog shows
  // the most-specific label. Only the key matters for an `agentRef` either way.
  const agentsByKey = new Map<string, { key: string; name: string; description?: string | null }>();
  for (const a of agentRows) {
    if (!agentsByKey.has(a.key)) {
      agentsByKey.set(a.key, { description: a.description, key: a.key, name: a.name });
    }
  }

  // mcp Connections are always team-owned (Connection.teamId is non-null), so we
  // can only surface them when a team scope is supplied.
  const mcpRows = teamId
    ? await prisma.connection.findMany({
        orderBy: { name: 'asc' },
        select: { description: true, id: true, name: true },
        where: { isActive: true, teamId, type: 'mcp' },
      })
    : [];

  // Effective container-image allowlist (built-in + team additions). Only fetched
  // when shell authoring is allowed, since otherwise the author can't use images.
  let shellImages: string[] = [];
  if (allowShell) {
    const team = teamId
      ? await prisma.team.findUnique({
          select: { shellImageAllowlist: true },
          where: { id: teamId },
        })
      : null;
    shellImages = [...BUILTIN_SHELL_IMAGES, ...(team?.shellImageAllowlist ?? [])];
  }

  return {
    agents: Array.from(agentsByKey.values()),
    allowShell,
    mcpConnections: mcpRows.map((c) => ({
      description: c.description,
      id: c.id,
      name: c.name ?? c.id,
    })),
    shellImages,
  };
}

export async function generateWorkflowSpec(
  input: GenerateWorkflowSpecInput
): Promise<GenerateWorkflowSpecResult> {
  heartbeat('generate workflow: building catalog');
  const catalog = await buildCatalog(input.teamId ?? null, input.allowShell ?? false);

  const spec = await resolveAgentSpec(
    {
      agentKey: 'workflowAuthor' as ModelBackedAgentKey,
      outputSchema: WorkflowAuthorOutputSchema,
    },
    { teamId: input.teamId ?? undefined }
  );

  // Refinement seeds the model with the current spec; a fresh generation starts
  // from the description alone. The repair loop below is identical either way —
  // it echoes the model's own last attempt (already a refined spec) + the errors.
  let message = input.baseSpec
    ? buildRefineRequestMessage({
        baseSpec: input.baseSpec,
        catalog,
        instruction: input.prompt,
      })
    : buildAuthorRequestMessage(input.prompt, catalog);
  let lastErrors: string[] = ['model produced no output'];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    heartbeat(`generate workflow: attempt ${attempt}/${MAX_ATTEMPTS}`);
    const result = await runAgent<WorkflowAuthorOutput>(spec, message, {
      spanName: 'llm.workflow_author',
    });

    const specJson = result.object?.specJson;
    const summary = result.object?.summary ?? '';
    if (!specJson) {
      // Tell the model what went wrong rather than re-sending the identical
      // request — a stateless re-issue would just reproduce the same omission.
      lastErrors = [
        'You did not return a non-empty `specJson` field. Return the full ' +
          'WorkflowSpec as a JSON string in the `specJson` field.',
      ];
      message = buildRepairRequestMessage({
        catalog,
        errors: lastErrors,
        intent: input.prompt,
        previousSpecJson: '(no specJson field was returned)',
      });
      continue;
    }

    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(specJson);
    } catch (e) {
      lastErrors = [`specJson is not valid JSON: ${(e as Error).message}`];
      message = buildRepairRequestMessage({
        catalog,
        errors: lastErrors,
        intent: input.prompt,
        previousSpecJson: specJson,
      });
      continue;
    }

    let validated: WorkflowSpec;
    try {
      validated = parseWorkflowSpec(parsedUnknown);
    } catch (e) {
      lastErrors = formatErrors(e);
      message = buildRepairRequestMessage({
        catalog,
        errors: lastErrors,
        intent: input.prompt,
        previousSpecJson: specJson,
      });
      continue;
    }

    // Static pre-execution validation beyond the schema (unparseable exprs,
    // unreachable nodes, no terminal path, …). Feed errors back so the author
    // self-corrects an unrunnable graph rather than us persisting one.
    const report = validateSpec(validated);
    if (report.errors.length === 0) {
      return { attempts: attempt, spec: validated, summary };
    }
    lastErrors = report.errors.map(formatValidationIssue);
    message = buildRepairRequestMessage({
      catalog,
      errors: lastErrors,
      intent: input.prompt,
      previousSpecJson: specJson,
    });
  }

  throw new Error(
    `workflowAuthor could not produce a valid WorkflowSpec after ${MAX_ATTEMPTS} attempts: ${lastErrors.join('; ')}`
  );
}
