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
  type Standing,
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

interface Evaluated {
  decision: Decision;
  standing: Standing;
}

interface RequestChecks {
  /** Declared capabilities this request was ALLOWED, which is what the backstop counts. */
  allowed: Set<CapabilityKey>;
  cache: Map<string, Evaluated>;
}

const checks = new WeakMap<FastifyRequest, RequestChecks>();

function checksOf(request: FastifyRequest): RequestChecks {
  let state = checks.get(request);
  if (!state) {
    state = { allowed: new Set(), cache: new Map() };
    checks.set(request, state);
  }
  return state;
}

/** The capabilities this route's handler declared it checks (`requireAuth({ handlerChecked })`). */
function declaredKeys(request: FastifyRequest): readonly CapabilityKey[] {
  return request.routeOptions?.config?.handlerChecked ?? [];
}

/**
 * Record an allowed check. Only a capability the route declared counts, and only an allowed
 * decision: a handler that asks, ignores a refusal and answers 200 has not checked anything.
 */
function recordAllowed(request: FastifyRequest, capability: CapabilityKey): void {
  if (declaredKeys(request).includes(capability)) {
    checksOf(request).allowed.add(capability);
  }
}

/** Whether a declared capability was checked and allowed for this request. */
export function wasChecked(request: FastifyRequest): boolean {
  return (checks.get(request)?.allowed.size ?? 0) > 0;
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

async function evaluate(
  request: FastifyRequest,
  capability: CapabilityKey,
  resource: Resource
): Promise<Evaluated> {
  const state = checksOf(request);
  const cacheKey = `${capability}:${JSON.stringify(resource ?? null)}`;
  let hit = state.cache.get(cacheKey);
  if (!hit) {
    const standing = await loadStanding(request.server.prisma, actorOf(request), resource);
    hit = { decision: decide(standing, capability, resource), standing };
    state.cache.set(cacheKey, hit);
  }
  if (hit.decision.allowed) {
    recordAllowed(request, capability);
  }
  return hit;
}

/**
 * Whether the request's caller holds `capability` on `resource`. Returns the decision and nothing
 * else: it sets no request-wide authority or team role, because a handler may ask about several
 * teams and a single field would carry the answer for whichever came last. A handler that needs the
 * authority reads it from the decision; one that needs a rank uses `actingRank` on a loaded standing.
 *
 * An allowed decision for a capability the route declared in `handlerChecked` satisfies the
 * `handler-checked` backstop; a refusal does not. The decision is cached for the request.
 */
export async function can(
  request: FastifyRequest,
  capability: CapabilityKey,
  resource?: Resource
): Promise<Decision> {
  return (await evaluate(request, capability, resource)).decision;
}

/** The set the caller may filter a list by. Marks the request as checked. */
export async function heldScope(
  request: FastifyRequest,
  capability: CapabilityKey
): Promise<HeldScope> {
  const held = await loadHeldScope(request.server.prisma, actorOf(request), capability);
  // A scope applied to a list is the check: it is declared like any other.
  recordAllowed(request, capability);
  return held;
}

/**
 * The status and body a refusal answers with. `hideAs404` answers a refusal as a missing thing, for
 * a route that hides existence: then a team that exists and one that does not answer alike.
 */
export function refusalOf(
  decision: Extract<Decision, { allowed: false }>,
  opts: { hideAs404?: boolean } = {}
): { status: 403 | 404; body: { error: { code: string; message: string; missing?: string } } } {
  if (opts.hideAs404) {
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
  if (def.scope === 'platform') {
    // A platform capability that a team role also confers (the user directory) is a person-level
    // question: does the caller hold the role in any team.
    resource = def.team ? { anyTeam: true } : undefined;
  } else {
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
  const { decision, standing } = await evaluate(request, capability, resource);
  if (!decision.allowed) {
    return replyRefusal(reply, decision, { hideAs404: options.hideAs404 });
  }
  // The route's own single decision is unambiguous, so the hook alone records it for the handler
  // and the audit context. A handler-level `can()` never writes these.
  request.authority = decision.authority;
  if (resource && 'teamId' in resource) {
    const stored = standing.teams.get(resource.teamId)?.storedRole;
    if (stored) {
      request.teamRole = stored;
    }
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
