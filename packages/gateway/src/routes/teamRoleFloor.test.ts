import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { RBAC_OPTIONS, type RBACOptions } from '../plugins/auth.js';
import { registerApiRoutes } from './register.js';

/**
 * A route that names a team (`requiredTeamRole`) lets that team's role decide. A platform role
 * above ENGINEER on the same route would demand a second, unrelated qualification, so a person who
 * leads a team but holds the platform ENGINEER role would see a lead badge and be refused.
 *
 * A tripwire, not a proof: it reads only hooks that carry `RBAC_OPTIONS`. A wrapper around
 * `requireAuth` that does not copy the symbol (see `plugins/auth.ts`) is not seen.
 */
interface TeamScopedRoute {
  method: string;
  options: RBACOptions;
  url: string;
}

let teamScoped: TeamScopedRoute[] = [];
/** Every route that asks for a platform LEAD, however it decides the rest. */
let platformLead: string[] = [];

beforeAll(async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  for (const name of ['prisma', 'temporal', 'auth', 'mcpBridge']) {
    app.decorate(name, {} as never);
  }
  const seen: TeamScopedRoute[] = [];
  const leadRoutes: string[] = [];
  app.addHook('onRoute', (route) => {
    const hooks = [route.onRequest ?? []].flat();
    for (const hook of hooks) {
      const options = (hook as { [RBAC_OPTIONS]?: RBACOptions })[RBAC_OPTIONS];
      if (options?.requiredRole === 'LEAD') {
        // Fastify adds a HEAD twin of every GET; it says nothing the GET does not.
        for (const method of [route.method].flat().filter((m) => m !== 'HEAD')) {
          leadRoutes.push(`${method} ${route.url}`);
        }
      }
      if (options?.requiredTeamRole) {
        for (const method of [route.method].flat()) {
          seen.push({ method, options, url: route.url });
        }
      }
    }
  });
  await registerApiRoutes(app);
  await app.ready();
  await app.close();
  teamScoped = seen;
  platformLead = leadRoutes.sort();
}, 60_000);

/**
 * Sandbox policy for a team's shell images and egress hosts is set by a platform ADMIN only, by
 * design (`canEditAllowlists` in the web package). The team check on these two routes is redundant
 * because a platform ADMIN bypasses it. A new route with a platform ADMIN floor and a team role
 * must be added here on purpose, with its reason.
 */
const PLATFORM_ADMIN_ONLY = new Set([
  'PUT /api/v1/teams/:id/shell-image-allowlist',
  'PUT /api/v1/teams/:id/egress-allowlist',
]);

describe('team-scoped routes', () => {
  it('walks a realistic number of routes that name a team role', () => {
    expect(teamScoped.length).toBeGreaterThan(10);
  });

  it('set no platform role floor above ENGINEER', () => {
    const offenders = teamScoped
      .filter(({ method, url }) => !PLATFORM_ADMIN_ONLY.has(`${method} ${url}`))
      .filter(({ options }) => options.requiredRole && options.requiredRole !== 'ENGINEER')
      .map(
        ({ method, url, options }) => `${method} ${url} requires platform ${options.requiredRole}`
      );
    expect(offenders).toEqual([]);
  });

  it('keeps the platform ADMIN exceptions real', () => {
    const adminOnly = teamScoped
      .filter(({ options }) => options.requiredRole === 'ADMIN')
      .map(({ method, url }) => `${method} ${url}`);
    expect(adminOnly.sort()).toEqual([...PLATFORM_ADMIN_ONLY].sort());
  });
});

/**
 * Routes whose handler, not a `requiredTeamRole`, decides who may act on a team's work (templates,
 * epics, campaigns, dependencies) must not ask for a platform LEAD either, or a team lead with the
 * platform ENGINEER role is refused before the handler runs. The organization-scoped error
 * baselines are the only routes that still do: they decide by organization membership (D5), so a
 * route added here needs the same reason.
 */
describe('platform LEAD routes', () => {
  it('are only the organization-scoped error baselines', () => {
    expect(platformLead).toEqual([
      'DELETE /api/v1/human-error-baselines/:id',
      'GET /api/v1/human-error-baselines',
      'POST /api/v1/human-error-baselines',
    ]);
  });
});
