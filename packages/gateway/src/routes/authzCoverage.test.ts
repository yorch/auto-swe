import { isCapabilityKey } from '@auto-swe/shared/permissions';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AuthzKind, annotateAuthz, RBAC_OPTIONS, type RBACOptions } from '../plugins/auth.js';
import { registerApiRoutes } from './register.js';

/**
 * Every route says how it is authorized. `requireAuth` records that in `config.authz` at
 * registration (`annotateAuthz`): `capability`, `handler-checked`, `service`, `authenticated`, or
 * `legacy` (still on the old role options). A route with no `requireAuth` hook is `public` only if
 * it declares so.
 *
 * The ratchet below counts the routes that are not yet on the new declaration. It only goes down:
 * lower `BASELINE` when a route is converted, never raise it. A new route must declare a
 * capability, `requireAuth()`, `serviceScopes` or `config.authz = 'public'`, or this test fails.
 *
 * A tripwire, not a proof: it reads only hooks that carry `RBAC_OPTIONS`. A wrapper around
 * `requireAuth` that does not copy the symbol is seen as having no hook.
 */

interface WalkedRoute {
  authz: AuthzKind | undefined;
  hasServiceScopes: boolean;
  keys: string[];
  label: string;
}

let routes: WalkedRoute[] = [];

beforeAll(async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  for (const name of ['prisma', 'temporal', 'auth', 'mcpBridge']) {
    app.decorate(name, {} as never);
  }
  // Registered first, so `route.config.authz` is set by the time the walker below reads it.
  app.addHook('onRoute', annotateAuthz);
  const seen: WalkedRoute[] = [];
  app.addHook('onRoute', (route) => {
    const phases = [route.onRequest, route.preValidation, route.preHandler];
    const hooks = phases.flatMap((phase) => (Array.isArray(phase) ? phase : phase ? [phase] : []));
    const keys: string[] = [];
    for (const hook of hooks) {
      const options = (hook as { [RBAC_OPTIONS]?: RBACOptions })[RBAC_OPTIONS];
      if (options?.capability) {
        keys.push(options.capability);
      }
      keys.push(...(options?.handlerChecked ?? []));
    }
    // Fastify adds a HEAD twin of every GET; it says nothing the GET does not.
    for (const method of [route.method].flat().filter((m) => m !== 'HEAD')) {
      seen.push({
        authz: route.config?.authz,
        hasServiceScopes: !!route.config?.serviceScopes?.length,
        keys,
        label: `${method} ${route.url}`,
      });
    }
  });
  await registerApiRoutes(app);
  await app.ready();
  await app.close();
  routes = seen;
}, 60_000);

/**
 * Routes not yet on the new declaration: `legacy`, plus those with no `requireAuth` hook that do
 * not declare `public`. Lower it as each domain converts; the end state is 0.
 */
const BASELINE = 674;
// At the time it was set: legacy 588, undeclared 86 (public receivers and hook-less routes);
// capability 0, handler-checked 0, service 18, authenticated 26. Deprecated alias mounts count
// once per mount.

function tally(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const route of routes) {
    const kind = route.authz ?? 'undeclared';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

describe('route authorization metadata', () => {
  it('walks a realistic number of routes', () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it('has no route that declares both a capability and serviceScopes', () => {
    const offenders = routes
      .filter((r) => r.authz === 'capability' && r.hasServiceScopes)
      .map((r) => r.label);
    expect(offenders).toEqual([]);
  });

  it('names only catalog keys in capability and handlerChecked declarations', () => {
    const unknown = routes
      .flatMap((r) => r.keys.map((key) => ({ key, label: r.label })))
      .filter(({ key }) => !isCapabilityKey(key))
      .map(({ key, label }) => `${label} names ${key}`);
    expect(unknown).toEqual([]);
  });

  it('gives every capability and handler-checked route at least one key', () => {
    const offenders = routes
      .filter(
        (r) => (r.authz === 'capability' || r.authz === 'handler-checked') && r.keys.length === 0
      )
      .map((r) => r.label);
    expect(offenders).toEqual([]);
  });

  it(`ratchet: routes on the legacy role options or undeclared stay at or under ${BASELINE}`, () => {
    const counts = tally();
    const notConverted = (counts.legacy ?? 0) + (counts.undeclared ?? 0);
    // The breakdown, so a failing run says where the routes are.
    console.info(`authz routes: ${JSON.stringify(counts)} (ratchet BASELINE ${BASELINE})`);
    expect(notConverted).toBeLessThanOrEqual(BASELINE);
  });
});
