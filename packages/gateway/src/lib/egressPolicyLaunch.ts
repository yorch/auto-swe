import { resolveSetting } from '@auto-swe/shared/config';
import {
  type EgressPolicy,
  egressPolicySchema,
  narrowEgressPolicy,
  stricterEgressPolicy,
} from '@auto-swe/shared/lib/egressPolicy';
import type { FastifyReply } from 'fastify';
import { sendError } from './httpErrors.js';

/**
 * Checks a launcher's requested `workspace.egressPolicy` against the cascade value this run would
 * pin. A launcher may only narrow it: a looser request is refused with `EGRESS_POLICY_WIDENS`
 * rather than clamped, so they learn the policy they asked for is not the one that would run.
 * The caller passes the scope the worker pins at: the run's connection's team and org (none for a
 * connection-less run) plus the template, so this check and the pin agree. The worker re-checks,
 * because other launch paths reach it.
 *
 * Resolves to `true` when it has already answered the request (the caller just returns). It never
 * resolves to the reply itself: a Fastify reply is thenable, so awaiting one that is returned
 * from an async function waits for the send and yields `undefined`.
 */
export async function refuseWideningEgressPolicy(
  reply: FastifyReply,
  requested: EgressPolicy | undefined,
  scope: { orgId?: string | null; teamId?: string | null; workflowTemplateId?: string }
): Promise<boolean> {
  if (requested === undefined) {
    return false;
  }
  // The registry types the value as `string`; the setting's own schema guarantees the three levels.
  const ceiling = egressPolicySchema.parse(
    await resolveSetting('workspace.egressPolicy', {
      orgId: scope.orgId ?? undefined,
      teamId: scope.teamId ?? undefined,
      workflowTemplateId: scope.workflowTemplateId,
    })
  );
  const narrowed = narrowEgressPolicy(ceiling, requested);
  if (narrowed.ok) {
    return false;
  }
  sendError(
    reply,
    400,
    'EGRESS_POLICY_WIDENS',
    `egressPolicy '${requested}' is looser than the '${narrowed.ceiling}' policy configured for this run; a launch may only narrow it`
  );
  return true;
}

/** The `egressPolicy` a launcher stored in a request's recorded JSON body; malformed is ignored. */
export function storedEgressPolicy(
  requestPayload: string | null | undefined
): EgressPolicy | undefined {
  if (!requestPayload) {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(requestPayload);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return undefined;
    }
    const parsed = egressPolicySchema.safeParse((body as Record<string, unknown>).egressPolicy);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The policy a re-run of a stored request pins: the launcher's stored choice, held at least as
 * strict as today's cascade value. A cascade tightened since the first launch tightens the re-run
 * too (it is never refused); a request that stored nothing returns `undefined` and follows the
 * cascade.
 */
export async function egressPolicyForRerun(
  stored: EgressPolicy | undefined,
  scope: { orgId?: string | null; teamId?: string | null; workflowTemplateId?: string }
): Promise<EgressPolicy | undefined> {
  if (stored === undefined) {
    return undefined;
  }
  const ceiling = egressPolicySchema.parse(
    await resolveSetting('workspace.egressPolicy', {
      orgId: scope.orgId ?? undefined,
      teamId: scope.teamId ?? undefined,
      workflowTemplateId: scope.workflowTemplateId,
    })
  );
  return stricterEgressPolicy(ceiling, stored);
}
