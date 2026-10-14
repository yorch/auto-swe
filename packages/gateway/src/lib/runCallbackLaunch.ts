import type { Prisma } from '@auto-swe/shared';
import {
  type CallbackRequest,
  callbackUrlMatchesEndpoint,
  endpointUrl,
  parseCallbackUrl,
  sealCallbackUrl,
} from '@auto-swe/shared/lib/runCallbacks';
import { checkProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sendError } from './httpErrors.js';

/**
 * The `callback` of a launch (docs/run-callbacks.md): which registered endpoint
 * it reports to, and the `RunCallback` row the launch writes with its request.
 *
 * A launch may only name a destination a team has registered: an endpoint of
 * one of `teams`, or a URL whose origin is exactly an endpoint's and whose
 * path lies under that endpoint's prefix. An arbitrary URL is never accepted,
 * so a caller cannot use the platform to send signed requests anywhere it
 * likes; the endpoint's managers decide where callbacks may go.
 */

/** Whose endpoints a launch may use: the listed teams, or every team for a platform admin. */
export type CallbackTeams = { kind: 'teams'; teamIds: string[] } | { kind: 'any' };

export type LaunchCallbackResult =
  | { ok: true; create: Record<string, unknown> | null; target: string | null }
  | { ok: false; status: 400; code: string; message: string };

const ENDPOINT_SELECT = {
  allowPrivateNetwork: true,
  id: true,
  origin: true,
  pathPrefix: true,
  teamId: true,
} as const;

function refused(code: string, message: string): LaunchCallbackResult {
  return { code, message, ok: false, status: 400 };
}

/** Teams the user belongs to, for a launch's `CallbackTeams`; every team for a platform admin. */
export async function callbackTeamsForUser(
  prisma: FastifyInstance['prisma'],
  user: { sub: string; role: string }
): Promise<CallbackTeams> {
  if (user.role === 'ADMIN') {
    return { kind: 'any' };
  }
  const memberships = await prisma.teamMembership.findMany({
    select: { teamId: true },
    where: { team: { isActive: true }, userId: user.sub },
  });
  return { kind: 'teams', teamIds: memberships.map((m) => m.teamId) };
}

async function findEndpoints(
  prisma: FastifyInstance['prisma'],
  teams: CallbackTeams,
  where: Prisma.CallbackEndpointWhereInput
) {
  if (teams.kind === 'any') {
    return runUnscoped(
      'a platform admin may report a run to any team’s registered endpoint',
      ['CallbackEndpoint'],
      () =>
        prisma.callbackEndpoint.findMany({
          select: ENDPOINT_SELECT,
          where: { ...where, disabledAt: null },
        })
    );
  }
  if (teams.teamIds.length === 0) {
    return [];
  }
  return prisma.callbackEndpoint.findMany({
    select: ENDPOINT_SELECT,
    where: { ...where, disabledAt: null, teamId: { in: teams.teamIds } },
  });
}

/**
 * Resolve a launch's `callback` to the row to write beside its request, or a
 * refusal. `workflowId` is the launch's Temporal workflow id: only that
 * execution reports, so a re-run of the request does not.
 */
export async function resolveLaunchCallback(
  prisma: FastifyInstance['prisma'],
  args: {
    callback: CallbackRequest | undefined;
    /** Whose endpoints may be used; a function is called only when a callback was asked for. */
    teams: CallbackTeams | (() => Promise<CallbackTeams>);
    workflowId: string;
  }
): Promise<LaunchCallbackResult> {
  const { callback } = args;
  if (!callback) {
    return { create: null, ok: true, target: null };
  }
  const teams = typeof args.teams === 'function' ? await args.teams() : args.teams;
  let endpoint: { id: string; origin: string; pathPrefix: string; allowPrivateNetwork: boolean };
  let url: string;
  let target: string;
  if (callback.endpointId) {
    const [found] = await findEndpoints(prisma, teams, { id: callback.endpointId });
    if (!found) {
      return refused(
        'CALLBACK_ENDPOINT_NOT_FOUND',
        'No enabled callback endpoint with that id in a team you belong to'
      );
    }
    endpoint = found;
    url = endpointUrl(found);
    target = url;
  } else {
    const parsed = parseCallbackUrl(callback.url as string);
    if (!parsed.ok) {
      return refused('INVALID_CALLBACK_URL', `callback.url refused: ${parsed.reason}`);
    }
    const candidates = (await findEndpoints(prisma, teams, { origin: parsed.value.origin })).filter(
      (e) => callbackUrlMatchesEndpoint(parsed.value, e)
    );
    if (candidates.length === 0) {
      return refused(
        'CALLBACK_URL_NOT_REGISTERED',
        'callback.url is not under an enabled callback endpoint of a team you belong to; register its origin and path prefix first'
      );
    }
    // The most specific prefix decides; two endpoints with the same prefix (in two teams) would
    // make the signing secret and the delivery history a guess, so that is refused.
    const longest = Math.max(...candidates.map((e) => e.pathPrefix.length));
    const best = candidates.filter((e) => e.pathPrefix.length === longest);
    if (best.length > 1) {
      return refused(
        'CALLBACK_URL_AMBIGUOUS',
        'callback.url matches more than one registered endpoint; name one with callback.endpointId'
      );
    }
    endpoint = best[0] as (typeof best)[number];
    url = parsed.value.url.href;
    target = parsed.value.target;
  }
  // The origin was checked when it was saved; the text guard is cheap, so check it again in
  // case the rules moved since.
  const guard = checkProbeUrl(endpoint.origin, { allowPrivate: endpoint.allowPrivateNetwork });
  if (!guard.ok) {
    return refused(
      'BASE_URL_REFUSED',
      `The callback endpoint's origin is refused: ${guard.reason}`
    );
  }
  return {
    create: {
      ...(callback.context != null ? { context: callback.context as object } : {}),
      endpointId: endpoint.id,
      target,
      workflowId: args.workflowId,
      ...sealCallbackUrl(url),
    },
    ok: true,
    target,
  };
}

/** Reply with a refusal from {@link resolveLaunchCallback}. */
export function sendCallbackRefusal(
  reply: FastifyReply,
  result: Extract<LaunchCallbackResult, { ok: false }>
) {
  return sendError(reply, result.status, result.code, result.message);
}

/** A launch body or payload without its `callback`, for storing as the request's raw payload. */
export function withoutCallback<T extends Record<string, unknown>>(body: T): Omit<T, 'callback'> {
  const { callback: _callback, ...rest } = body;
  return rest;
}
