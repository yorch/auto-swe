import { isCapabilityKey } from '@auto-swe/shared/permissions';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AuthzKind, annotateAuthz, RBAC_OPTIONS, type RBACOptions } from '../plugins/auth.js';
import { registerApiRoutes } from './register.js';

/**
 * Every route says how it is authorized. `requireAuth` records that in `config.authz` at
 * registration (`annotateAuthz`): `capability`, `handler-checked`, `service` or `authenticated`.
 * A route with no `requireAuth` hook is `public` only if it declares `config.authz = 'public'` with
 * a `publicReason` naming what authenticates it (or why nothing needs to).
 *
 * The set of public routes is a reviewed list, `REVIEWED_PUBLIC` below: adding a public route means
 * adding it there, in the same change, where a reviewer sees it. A new route must declare a
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
  publicReason: string | undefined;
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
        publicReason: route.config?.publicReason,
      });
    }
  });
  await registerApiRoutes(app);
  await app.ready();
  await app.close();
  routes = seen;
}, 60_000);

/**
 * Every route that is public: no `requireAuth` hook, so whatever protects it is in its handler.
 * Each is reviewed: a webhook or callback proves itself with a signature or a signed state, a
 * public link carries a signed token. A route added here needs the same kind of reason.
 */
const REVIEWED_PUBLIC = [
  'GET /api/v1/auth/slack/callback',
  'GET /api/v1/auth/slack/install/callback',
  'GET /api/v1/integrations/github-app-manifest/callback',
  'GET /api/v1/report-digests/unsubscribe',
  'POST /api/v1/auth/slack/commands',
  'POST /api/v1/auth/slack/events',
  'POST /api/v1/auth/slack/interactive',
  'POST /api/v1/report-digests/unsubscribe',
  'POST /api/v1/webhooks/:token',
  'POST /api/v1/webhooks/access',
  'POST /api/v1/webhooks/ci',
  'POST /api/v1/webhooks/events/:endpointId',
  'POST /api/v1/webhooks/git',
  'POST /api/v1/webhooks/jira',
];

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

  it('gives every route an authorization kind', () => {
    const undeclared = routes.filter((r) => !r.authz).map((r) => r.label);
    expect(undeclared).toEqual([]);
  });

  it('gives every public route a non-empty publicReason, and no other route one', () => {
    const missing = routes
      .filter((r) => r.authz === 'public' && !r.publicReason?.trim())
      .map((r) => r.label);
    expect(missing).toEqual([]);
    const stray = routes.filter((r) => r.authz !== 'public' && r.publicReason).map((r) => r.label);
    expect(stray).toEqual([]);
  });

  it('has exactly the reviewed set of public routes', () => {
    const open = routes
      .filter((r) => r.authz === 'public')
      .map((r) => r.label)
      .sort();
    expect(open).toEqual([...REVIEWED_PUBLIC].sort());
  });

  it('declares no authorization kind outside the known set', () => {
    const known = new Set(['capability', 'handler-checked', 'service', 'authenticated', 'public']);
    expect(routes.filter((r) => r.authz && !known.has(r.authz)).map((r) => r.label)).toEqual([]);
    console.info(`authz routes: ${JSON.stringify(tally())}`);
  });
});
