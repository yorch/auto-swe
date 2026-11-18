import {
  CATALOG,
  type CapabilityDef,
  type CapabilityKey,
  type Decision,
  decide,
  type HeldScope,
  heldScope as loadHeldScope,
  loadStanding,
  type Resource,
  userActor,
} from '@auto-swe/shared/permissions';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload, RBACOptions } from '../plugins/auth.js';

/**
 * Capability checks for the gateway: the shared resolver (`@auto-swe/shared/permissions`) bound to
 * a request. Two entry points:
 *
 *   - `requireAuth({ capability, team: { param } })` declares the check on the route, and
 *     `enforceCapability` (called from that hook) answers 403 `FORBIDDEN` with `error.missing`.
 *   - A handler whose resource comes from the body or a lookup calls `can(request, …)` itself and
 *     declares `requireAuth({ handlerChecked: [...] })`. Any call here records that the request was
 *     checked, which the `handler-checked` backstop reads.
 *
 * The decision is cached for the life of the request, never across requests.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestChecks {
  /** Capabilities asked about on this request, by key. */
  asked: Set<CapabilityKey>;
  cache: Map<string, Decision>;
}

const checks = new WeakMap<FastifyRequest, RequestChecks>();

function checksOf(request: FastifyRequest): RequestChecks {
  let state = checks.get(request);
  if (!state) {
    state = { asked: new Set(), cache: new Map() };
    checks.set(request, state);
  }
  return state;
}

/** Whether any capability check (`can`, `heldScope`, or the route's own) ran for this request. */
export function wasChecked(request: FastifyRequest): boolean {
  return (checks.get(request)?.asked.size ?? 0) > 0;
}

/** Record a check that was made some other way (for example by an existing helper). */
export function markChecked(request: FastifyRequest, capability: CapabilityKey): void {
  checksOf(request).asked.add(capability);
}

/** The shared actor for this request: the person, or the service principal. */
export function actorOf(request: FastifyRequest) {
  if (request.principal) {
    return { id: request.principal.servicePrincipalId, kind: 'principal' as const };
  }
  if (!request.user) {
    throw new Error('actorOf called without requireAuth middleware');
  }
  return userActor(request.user);
}

/**
 * Whether the request's caller holds `capability` on `resource`. Marks the request as checked, sets
 * `request.authority` when it allows, and sets `request.teamRole` (the stored membership role,
 * as the older checks do) when the resource names one team the caller belongs to.
 */
export async function can(
  request: FastifyRequest,
  capability: CapabilityKey,
  resource?: Resource
): Promise<Decision> {
  const state = checksOf(request);
  state.asked.add(capability);
  const cacheKey = `${capability}:${JSON.stringify(resource ?? null)}`;
  const cached = state.cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const actor = actorOf(request);
  const standing = await loadStanding(request.server.prisma, actor, resource);
  const decision = decide(standing, capability, resource);
  state.cache.set(cacheKey, decision);
  if (decision.allowed) {
    request.authority = decision.authority;
    if (resource && 'teamId' in resource) {
      const stored = standing.teams.get(resource.teamId)?.storedRole;
      if (stored) {
        request.teamRole = stored;
      }
    }
  }
  return decision;
}

/** The set the caller may filter a list by. Marks the request as checked. */
export async function heldScope(
  request: FastifyRequest,
  capability: CapabilityKey
): Promise<HeldScope> {
  markChecked(request, capability);
  return loadHeldScope(request.server.prisma, actorOf(request), capability);
}

/** The status and body a refusal answers with. `hideAs404` answers a refusal as a missing thing. */
export function refusalOf(
  decision: Extract<Decision, { allowed: false }>,
  opts: { hideAs404?: boolean } = {}
): { status: 403 | 404; body: { error: { code: string; message: string; missing?: string } } } {
  if (opts.hideAs404 || decision.code === 'NOT_FOUND') {
    return { body: { error: { code: 'NOT_FOUND', message: 'Not found' } }, status: 404 };
  }
  return {
    body: {
      error: {
        code: 'FORBIDDEN',
        message: `${decision.reason.charAt(0).toUpperCase()}${decision.reason.slice(1)}`,
        missing: decision.missing,
      },
    },
    status: 403,
  };
}

/** Send a refusal. */
export function replyRefusal(
  reply: FastifyReply,
  decision: Extract<Decision, { allowed: false }>,
  opts: { hideAs404?: boolean } = {}
) {
  const { status, body } = refusalOf(decision, opts);
  return reply.status(status).send(body);
}

function paramOf(request: FastifyRequest, name: string): string | undefined {
  return (request.params as Record<string, string> | undefined)?.[name];
}

/**
 * The route's capability check, run by `requireAuth` after authentication. Returns the sent reply
 * when it refused (the hook must `return` it), or `undefined` to carry on.
 */
export async function enforceCapability(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: JwtPayload,
  options: RBACOptions
): Promise<FastifyReply | undefined> {
  const capability = options.capability;
  if (!capability) {
    return undefined;
  }
  const def: CapabilityDef = CATALOG[capability];

  let resource: Resource;
  if (def.scope !== 'platform') {
    // A team capability reads a team id; an org capability reads an org id, or the org of a team
    // when the route names one. The defaults match the old `teamIdParam`/`orgIdParam`.
    const useTeam =
      def.scope === 'team' || (options.team !== undefined && options.org === undefined);
    const name = useTeam ? (options.team?.param ?? 'id') : (options.org?.param ?? 'orgId');
    const value = paramOf(request, name);
    if (!value) {
      // The route promised an id parameter and did not declare one: a server misconfiguration.
      return reply.status(500).send({
        error: {
          code: 'SERVER_ERROR',
          message: `${useTeam ? 'Team' : 'Organization'} ID route parameter missing`,
        },
      });
    }
    if (!UUID_RE.test(value)) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_ID',
          message: `${useTeam ? 'Team' : 'Organization'} ID must be a valid UUID`,
        },
      });
    }
    resource = useTeam ? { teamId: value } : { orgId: value };
  }

  // `can` reads the user from the request; the hook has just set it.
  request.user = payload;
  const decision = await can(request, capability, resource);
  if (!decision.allowed) {
    return replyRefusal(reply, decision, { hideAs404: options.hideAs404 });
  }
  return undefined;
}

/**
 * The `handler-checked` backstop, run in `onSend`: a route that declares its handler decides must
 * not answer 2xx without having asked. Throws under `NODE_ENV=test` so a test fails; elsewhere it
 * logs `authz.unchecked`, because refusing a response that was already built helps nobody.
 */
export async function assertHandlerChecked(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  if (reply.statusCode >= 200 && reply.statusCode < 300 && !wasChecked(request)) {
    const route = `${request.method} ${request.routeOptions?.url ?? request.url}`;
    if (process.env.NODE_ENV === 'test') {
      throw new Error(
        `${route} is declared handler-checked but answered without a capability check`
      );
    }
    request.log.error({ route }, 'authz.unchecked');
  }
  return payload;
}
