import { prisma } from '@auto-swe/shared/db';
import {
  CancelIntentSchema,
  MessageIntentSchema,
  ProposeCampaignIntentSchema,
  RequestRepoIntentSchema,
  SpawnIntentSchema,
} from '@auto-swe/shared/lib/orchestration';
import {
  CampaignProposalResponseSchema,
  SpawnChildResponseSchema,
} from '@auto-swe/shared/lib/orchestrationApi';
import { repoMemberWhere } from '@auto-swe/shared/lib/repoMembership';
import { logWarn } from '../lib/activityLog.js';
import { redactString } from '../lib/agentTracer.js';
import { memoryInjectionMatches } from '../lib/memoryGuard.js';
import {
  createOrchestrationGateway,
  type OrchestrationGateway,
  type OrchestrationGatewayResponse,
  redactOrchestrationTokens,
} from '../lib/orchestrationGateway.js';
import { assertCurrentWorkflowOwns } from '../lib/orchestrationIdentity.js';
import {
  countOrchestrationLoad,
  hasPendingAttach,
  writeNotice,
} from '../lib/orchestrationState.js';
import type {
  ApplyOrchestrationIntentsInput,
  ApplyOrchestrationIntentsResult,
  OrchestratorIntent,
} from '../lib/orchestrationTypes.js';

/**
 * Apply the intents an orchestrator turn recorded, in order. This is fixed code, not the model:
 * a spawn, message or cancel goes to the gateway with a per-call orchestration token and the gateway is
 * the authority; a repository request is checked here and becomes an `ATTACH_REQUEST` message.
 *
 * A refusal is never retried. It becomes a SYSTEM `NOTICE` carrying the gateway's code, which the
 * next orchestrator turn reads. Single attempt (the workflow proxy sets it): a second attempt
 * could start a child twice.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTICE_MESSAGE_CHARS = 300;

/** Codes this activity raises itself; the gateway's come from `ORCHESTRATION_REFUSAL_CODES`. */
const LOCAL_CODES = {
  attachPending: 'ATTACH_ALREADY_PENDING',
  attachUnavailable: 'ATTACH_NOT_AVAILABLE',
  gatewayError: 'GATEWAY_ERROR',
  gatewayUnreachable: 'GATEWAY_UNREACHABLE',
  invalidIntent: 'INVALID_INTENT',
  proposalDropped: 'PROPOSAL_REPOS_DROPPED',
  proposalScreened: 'PROPOSAL_SCREENED',
} as const;

/**
 * The code and message of a gateway error, from either shape it answers with: an orchestration
 * refusal (`{ code, error: { code, message }, message }`) or the ordinary envelope every other route
 * uses (`{ error: { code, message } }`, e.g. `AGENT_NOT_FOUND`, `CAP_EXCEEDS_CEILING`). The code is
 * kept only when it is an upper-case identifier; the message is stripped of control characters and
 * markup, redacted and length-capped. Null when the body carries neither.
 */
export function parseGatewayError(
  body: unknown
): { code: string | null; message: string | null } | null {
  const record = (v: unknown): Record<string, unknown> | null =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const top = record(body);
  if (!top) {
    return null;
  }
  const nested = record(top.error);
  const pick = (key: 'code' | 'message'): unknown => nested?.[key] ?? top[key];
  const rawCode = pick('code');
  const rawMessage = pick('message');
  const code =
    typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(rawCode) ? rawCode : null;
  const message =
    typeof rawMessage === 'string'
      ? redactOrchestrationTokens(
          redactString(
            rawMessage
              .replace(/[\p{Cc}<>]+/gu, ' ')
              .replace(/\s+/g, ' ')
              .trim()
          )
        ).slice(0, NOTICE_MESSAGE_CHARS)
      : null;
  return code || message ? { code, message: message || null } : null;
}

export async function applyOrchestrationIntents(
  input: ApplyOrchestrationIntentsInput
): Promise<ApplyOrchestrationIntentsResult> {
  assertCurrentWorkflowOwns(input.orchestrationId);
  return applyIntents(input, createOrchestrationGateway(input.orchestrationId));
}

/** The body of the activity with the gateway client supplied, for tests. */
export async function applyIntents(
  input: ApplyOrchestrationIntentsInput,
  gateway: OrchestrationGateway
): Promise<ApplyOrchestrationIntentsResult> {
  const { orchestrationId } = input;
  if (!UUID_RE.test(orchestrationId)) {
    throw new Error('orchestrationId is not a uuid');
  }
  let spawned = 0;
  let refused = 0;
  const base = `/api/v1/orchestrations/${orchestrationId}`;

  const refuse = async (what: string, code: string, detail?: string) => {
    refused += 1;
    try {
      await writeNotice(
        orchestrationId,
        code,
        `${what} was not done (${code})${detail ? `: ${detail}` : '.'}`,
        { intent: what.slice(0, 80) }
      );
    } catch (err) {
      // The refusal still counts and the remaining intents still run; only the notice is lost.
      logWarn('orchestration refusal notice not written', {
        code,
        error: err instanceof Error ? err.message : String(err),
        orchestrationId,
      });
    }
  };

  const call = async (
    path: string,
    body: unknown
  ): Promise<OrchestrationGatewayResponse | { error: true }> => {
    try {
      return await gateway.post(path, body);
    } catch (err) {
      logWarn('orchestration gateway call failed', {
        error: redactOrchestrationTokens(err instanceof Error ? err.message : String(err)),
        orchestrationId,
      });
      return { error: true };
    }
  };

  /** Turn a non-success gateway answer into a notice. Returns true when it was a success. */
  const settle = async (
    what: string,
    res: OrchestrationGatewayResponse | { error: true }
  ): Promise<boolean> => {
    if ('error' in res) {
      await refuse(what, LOCAL_CODES.gatewayUnreachable, 'the platform could not be reached');
      return false;
    }
    if (res.status >= 200 && res.status < 300) {
      return true;
    }
    const parsed = parseGatewayError(res.body);
    if (parsed) {
      // The real code and message, so the orchestrator can correct itself. The message is quoted
      // data from the platform, not an instruction.
      await refuse(
        what,
        parsed.code ?? LOCAL_CODES.gatewayError,
        `HTTP ${res.status}${parsed.message ? `; the platform said (quoted): ${JSON.stringify(parsed.message)}` : ''}`
      );
    } else {
      await refuse(what, LOCAL_CODES.gatewayError, `HTTP ${res.status}`);
    }
    return false;
  };

  const applyOne = async (recorded: OrchestratorIntent, i: number): Promise<void> => {
    switch (recorded.kind) {
      case 'spawn': {
        const parsed = SpawnIntentSchema.safeParse(recorded.intent);
        const label = parsed.success ? parsed.data.label : 'A spawn request';
        if (!parsed.success) {
          await refuse(
            `Starting "${label}"`,
            LOCAL_CODES.invalidIntent,
            'the request was malformed'
          );
          return;
        }
        const res = await call(`${base}/children`, {
          intent: parsed.data,
          turnKey: `${input.turnKey}:${i}`,
        });
        const ok = await settle(`Starting "${label}"`, res);
        // The gateway answers `{ data: { childId, ... } }`.
        const answer =
          ok && !('error' in res) ? SpawnChildResponseSchema.safeParse(unwrapData(res.body)) : null;
        if (answer?.success) {
          spawned += 1;
          if (answer.data.clamped) {
            await noteClamped(orchestrationId, answer.data.clamped.maxSteps);
          }
        } else if (ok) {
          await refuse(
            `Starting "${label}"`,
            LOCAL_CODES.gatewayError,
            'the answer was unreadable'
          );
        }
        return;
      }
      case 'message': {
        // Re-validated here: the intent crossed the activity boundary as plain data.
        const parsed = MessageIntentSchema.safeParse(recorded.intent);
        if (!parsed.success || !UUID_RE.test(parsed.data.childId)) {
          await refuse(
            'A message to a child',
            LOCAL_CODES.invalidIntent,
            'unknown child id or malformed message'
          );
          return;
        }
        await settle(
          'A message to a child',
          await call(`${base}/children/${parsed.data.childId}/messages`, {
            body: parsed.data.message,
          })
        );
        return;
      }
      case 'cancel': {
        const parsed = CancelIntentSchema.safeParse(recorded.intent);
        if (!parsed.success || !UUID_RE.test(parsed.data.childId)) {
          await refuse('A cancel request', LOCAL_CODES.invalidIntent, 'unknown child id');
          return;
        }
        await settle(
          'A cancel request',
          await call(`${base}/children/${parsed.data.childId}/cancel`, {})
        );
        return;
      }
      case 'requestRepo': {
        const parsed = RequestRepoIntentSchema.safeParse(recorded.intent);
        if (!parsed.success) {
          await refuse(
            'The repository request',
            LOCAL_CODES.invalidIntent,
            'the request was malformed'
          );
          return;
        }
        await applyRepoRequest(orchestrationId, { ...recorded, intent: parsed.data }, refuse);
        return;
      }
      case 'proposeCampaign': {
        const what = 'The campaign proposal';
        const parsed = ProposeCampaignIntentSchema.safeParse(recorded.intent);
        if (!parsed.success) {
          await refuse(what, LOCAL_CODES.invalidIntent, 'the proposal was malformed');
          return;
        }
        // The text reaches a person who may launch it and, once launched, an agent: it is model
        // output, so it is screened for injection first, and a text that cannot be screened is
        // not sent. The fixed notice names no part of it.
        const { brief, name, recipe } = parsed.data;
        const scan = await memoryInjectionMatches([
          name,
          brief,
          ...(recipe ? [recipe.ref, ...Object.values(recipe.params).map(String)] : []),
        ]).catch(() => null);
        if (scan === null || scan.loadFailed || scan.incomplete || scan.matches.length > 0) {
          await refuse(
            what,
            LOCAL_CODES.proposalScreened,
            'its text could not be accepted; propose again with plain wording'
          );
          return;
        }
        const res = await call(`${base}/campaign-proposals`, parsed.data);
        const ok = await settle(what, res);
        if (!ok || 'error' in res) {
          return;
        }
        const answer = CampaignProposalResponseSchema.safeParse(unwrapData(res.body));
        if (!answer.success) {
          await refuse(what, LOCAL_CODES.gatewayError, 'the answer was unreadable');
          return;
        }
        if (answer.data.droppedRepoCount > 0) {
          // A count only: which ids, and why, would tell the model what the launcher can reach.
          await writeNotice(
            orchestrationId,
            LOCAL_CODES.proposalDropped,
            `${answer.data.droppedRepoCount} repositories named in the campaign proposal are not available to the person and were left out of it.`,
            { droppedRepoCount: answer.data.droppedRepoCount }
          );
        }
        return;
      }
    }
  };

  let index = 0;
  for (const recorded of input.intents) {
    const i = index++;
    try {
      await applyOne(recorded, i);
    } catch (err) {
      // One intent failing (a database write, say) must not abort the ones after it.
      logWarn('orchestration intent could not be applied', {
        error: redactOrchestrationTokens(err instanceof Error ? err.message : String(err)),
        index: i,
        kind: recorded.kind,
        orchestrationId,
      });
      refused += 1;
    }
  }

  const [load, pendingAttach] = await Promise.all([
    countOrchestrationLoad(orchestrationId),
    hasPendingAttach(orchestrationId),
  ]);
  return {
    pendingApprovals: load.pendingApprovals,
    pendingAttach,
    refused,
    runningChildren: load.runningChildren,
    spawned,
    wait: load.runningChildren > 0 || load.pendingApprovals > 0 || pendingAttach,
  };
}

/** The body's `data` member when it has one, else the body itself. */
function unwrapData(body: unknown): unknown {
  return typeof body === 'object' && body !== null && 'data' in body
    ? (body as { data: unknown }).data
    : body;
}

/**
 * Tell the next orchestrator turn that the gateway lowered a child's step limit to the platform
 * ceiling. Fixed wording and a number only, so no model text reaches the notice. A failed write
 * loses the notice, never the spawn.
 */
async function noteClamped(orchestrationId: string, maxSteps: number): Promise<void> {
  try {
    await writeNotice(
      orchestrationId,
      'MAX_STEPS_CLAMPED',
      `A child you started asked for more steps than the platform allows, so its step limit was lowered to ${maxSteps}.`,
      { maxSteps }
    );
  } catch (err) {
    logWarn('orchestration clamp notice not written', {
      error: err instanceof Error ? err.message : String(err),
      orchestrationId,
    });
  }
}

/**
 * A repository request: refused when one is already attached or pending; otherwise recorded as an
 * `ATTACH_REQUEST` message the launcher confirms. A candidate the launcher cannot reach is dropped
 * without a trace, so the request looks the same as one naming a repository that does not exist.
 */
async function applyRepoRequest(
  orchestrationId: string,
  recorded: Extract<OrchestratorIntent, { kind: 'requestRepo' }>,
  refuse: (what: string, code: string, detail?: string) => Promise<void>
): Promise<void> {
  const what = 'The repository request';
  const orch = await prisma.orchestration.findUnique({
    select: { launchedById: true, repoId: true },
    where: { id: orchestrationId },
  });
  if (!orch) {
    await refuse(what, LOCAL_CODES.invalidIntent, 'the orchestration no longer exists');
    return;
  }
  if (orch.repoId) {
    await refuse(what, 'REPO_ALREADY_ATTACHED', 'a repository is already attached');
    return;
  }
  if (!orch.launchedById) {
    // A service principal acts as no one, so nobody can confirm.
    await refuse(
      what,
      LOCAL_CODES.attachUnavailable,
      'this orchestration has no person to confirm'
    );
    return;
  }
  if (await hasPendingAttach(orchestrationId)) {
    await refuse(what, LOCAL_CODES.attachPending, 'one request is already waiting for the person');
    return;
  }
  const { candidate, reason } = recorded.intent;
  let candidateRepoId: string | null = null;
  if (candidate) {
    const reachable = await prisma.connection.findFirst({
      select: { id: true },
      where: {
        id: candidate,
        type: 'git_repo',
        ...repoMemberWhere({ userId: orch.launchedById }),
      },
    });
    candidateRepoId = reachable?.id ?? null;
  }
  await prisma.orchestrationMessage.create({
    data: {
      body: redactString(reason).slice(0, 500),
      kind: 'ATTACH_REQUEST',
      orchestrationId,
      // No status: the gateway marks the outcome with `resolution` (`isAttachRequestPending`).
      payload: { candidateRepoId, reason: redactString(reason).slice(0, 500) },
      role: 'ORCHESTRATOR',
    },
  });
}
