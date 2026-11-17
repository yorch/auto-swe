import { prisma } from '@auto-swe/shared/db';
import { SpawnIntentSchema } from '@auto-swe/shared/lib/orchestration';
import {
  OrchestrationRefusalSchema,
  SpawnChildResponseSchema,
} from '@auto-swe/shared/lib/orchestrationApi';
import { repoMemberWhere } from '@auto-swe/shared/lib/repoMembership';
import { logWarn } from '../lib/activityLog.js';
import { redactString } from '../lib/agentTracer.js';
import {
  createOrchestrationGateway,
  type OrchestrationGateway,
  type OrchestrationGatewayResponse,
} from '../lib/orchestrationGateway.js';
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
import { redactToken } from '../lib/redactToken.js';

/**
 * Apply the intents an orchestrator turn recorded, in order. This is fixed code, not the model:
 * a spawn, message or cancel goes to the gateway with the orchestration token and the gateway is
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
} as const;

export async function applyOrchestrationIntents(
  input: ApplyOrchestrationIntentsInput
): Promise<ApplyOrchestrationIntentsResult> {
  return applyIntents(input, createOrchestrationGateway(input.token));
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
    await writeNotice(
      orchestrationId,
      code,
      `${what} was not done (${code})${detail ? `: ${detail}` : '.'}`,
      { intent: what.slice(0, 80) }
    );
  };

  const call = async (
    path: string,
    body: unknown
  ): Promise<OrchestrationGatewayResponse | { error: true }> => {
    try {
      return await gateway.post(path, body);
    } catch (err) {
      logWarn('orchestration gateway call failed', {
        error: redactToken(err instanceof Error ? err.message : String(err), input.token),
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
    const refusal = OrchestrationRefusalSchema.safeParse(res.body);
    if (refusal.success) {
      await refuse(
        what,
        refusal.data.code,
        redactToken(redactString(refusal.data.message), input.token).slice(0, NOTICE_MESSAGE_CHARS)
      );
    } else {
      await refuse(what, LOCAL_CODES.gatewayError, `HTTP ${res.status}`);
    }
    return false;
  };

  let index = 0;
  for (const recorded of input.intents) {
    const i = index++;
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
          break;
        }
        const res = await call(`${base}/children`, {
          intent: parsed.data,
          turnKey: `${input.turnKey}:${i}`,
        });
        const ok = await settle(`Starting "${label}"`, res);
        if (ok && !('error' in res) && SpawnChildResponseSchema.safeParse(res.body).success) {
          spawned += 1;
        } else if (ok) {
          await refuse(
            `Starting "${label}"`,
            LOCAL_CODES.gatewayError,
            'the answer was unreadable'
          );
        }
        break;
      }
      case 'message': {
        const { childId, message } = recorded.intent;
        if (!UUID_RE.test(childId)) {
          await refuse('A message to a child', LOCAL_CODES.invalidIntent, 'unknown child id');
          break;
        }
        await settle(
          'A message to a child',
          await call(`${base}/children/${childId}/messages`, { body: message })
        );
        break;
      }
      case 'cancel': {
        const { childId } = recorded.intent;
        if (!UUID_RE.test(childId)) {
          await refuse('A cancel request', LOCAL_CODES.invalidIntent, 'unknown child id');
          break;
        }
        await settle('A cancel request', await call(`${base}/children/${childId}/cancel`, {}));
        break;
      }
      case 'requestRepo':
        await applyRepoRequest(orchestrationId, recorded, refuse);
        break;
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
