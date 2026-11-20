import { CATALOG } from '@auto-swe/shared/permissions';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { RBAC_OPTIONS, type RBACOptions } from '../plugins/auth.js';
import { registerApiRoutes } from './register.js';

/**
 * The platform role and the team role used to stack: a route that named a team role could also
 * ask for a platform role above the lowest, so a person who led a team but held the lowest
 * platform role saw a lead badge and was refused. Authorization is now one capability per route,
 * decided from the person's standing in the team or organization the route names, so there is no
 * second qualification to stack.
 *
 * A tripwire, not a proof: it reads only hooks that carry `RBAC_OPTIONS`. A wrapper around
 * `requireAuth` that does not copy the symbol (see `plugins/auth.ts`) is not seen.
 */
interface CapabilityRoute {
  capability: string;
  method: string;
  options: RBACOptions;
  url: string;
}

/** The catalog is a literal-typed object; read a definition's optional fields by key. */
function definitionOf(capability: string): {
  org?: string;
  platformAdmin?: boolean;
  team?: string;
} {
  return CATALOG[capability as keyof typeof CATALOG] as unknown as {
    org?: string;
    platformAdmin?: boolean;
    team?: string;
  };
}

let capabilityRoutes: CapabilityRoute[] = [];
/** Every route whose hook carries an option outside the declared set: a stacked role floor. */
let platformFloor: string[] = [];
const DECLARED_OPTIONS = new Set(['capability', 'handlerChecked', 'hideAs404', 'team', 'org']);

beforeAll(async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  for (const name of ['prisma', 'temporal', 'auth', 'mcpBridge']) {
    app.decorate(name, {} as never);
  }
  const seen: CapabilityRoute[] = [];
  const floors: string[] = [];
  app.addHook('onRoute', (route) => {
    const hooks = [route.onRequest ?? []].flat();
    for (const hook of hooks) {
      const options = (hook as { [RBAC_OPTIONS]?: RBACOptions })[RBAC_OPTIONS];
      if (!options) {
        continue;
      }
      // Fastify adds a HEAD twin of every GET; it says nothing the GET does not.
      const methods = [route.method].flat().filter((m) => m !== 'HEAD');
      const undeclared = Object.keys(options).filter((key) => !DECLARED_OPTIONS.has(key));
      if (undeclared.length > 0) {
        for (const method of methods) {
          floors.push(`${method} ${route.url} carries ${undeclared.join(', ')}`);
        }
      }
      if (options.capability) {
        for (const method of methods) {
          seen.push({ capability: options.capability, method, options, url: route.url });
        }
      }
    }
  });
  await registerApiRoutes(app);
  await app.ready();
  await app.close();
  capabilityRoutes = seen;
  platformFloor = floors.sort();
}, 60_000);

/**
 * Sandbox policy for a team's shell images and egress hosts is set by a platform admin only, by
 * design (`canEditAllowlists` in the web package). The capability that guards these two routes
 * must stay one that no team role or organization role can hold; a route added here needs the
 * same reason.
 */
const PLATFORM_ADMIN_ONLY = new Set([
  'PUT /api/v1/teams/:id/shell-image-allowlist',
  'PUT /api/v1/teams/:id/egress-allowlist',
]);

describe('capability routes', () => {
  it('walks a realistic number of routes that declare a capability', () => {
    expect(capabilityRoutes.length).toBeGreaterThan(10);
  });

  it('keeps the sandbox policy routes behind a platform-admin-only capability', () => {
    const sandbox = capabilityRoutes.filter(({ method, url }) =>
      PLATFORM_ADMIN_ONLY.has(`${method} ${url}`)
    );
    expect(sandbox.map(({ method, url }) => `${method} ${url}`).sort()).toEqual(
      [...PLATFORM_ADMIN_ONLY].sort()
    );
    for (const { capability } of sandbox) {
      const def = definitionOf(capability);
      expect(def.team, capability).toBeUndefined();
      expect(def.org, capability).toBeUndefined();
    }
  });

  it('refuses a platform admin bypass that a route did not intend', () => {
    // A capability route can be reached by a platform admin only when its definition says so.
    const optedOut = capabilityRoutes.filter(
      ({ capability }) => definitionOf(capability).platformAdmin === false
    );
    expect(optedOut.map(({ capability }) => capability)).toEqual([]);
  });
});

describe('platform role floors', () => {
  it('no route stacks a role floor or any option beyond the declared ones', () => {
    expect(platformFloor).toEqual([]);
  });
});
