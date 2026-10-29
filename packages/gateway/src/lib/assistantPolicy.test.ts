import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerApiRoutes } from '../routes/register.js';
import {
  ASSISTANT_ROUTE_POLICY,
  assistantAccess,
  policyKey,
  policyPatternFor,
} from './assistantPolicy.js';

/**
 * The policy table against the routes production registers. Every route must have a decision, every
 * decision must name a real route, and the categories the assistant may never touch must be refused
 * whatever an edit to the table says.
 */

/** Receivers with their own authentication (HMAC, Slack signatures, OAuth callbacks): no user. */
const RECEIVERS =
  /^\/api\/v1\/(webhooks(\/|$)|auth\/slack\/(callback|install\/callback|interactive|commands|events)$)/;
/** Deprecated aliases, refused to the assistant by having no entries. */
const ALIASES = /^\/api\/v1\/(admin|inbox)(\/|$)/;

/**
 * Tripwire for the categories the assistant never touches (`docs/history/in-app-assistant.md` D3). A
 * route matching one of these must be refused; a false positive is fixed by narrowing the pattern,
 * never by loosening the table.
 */
const SECRET_PATHS =
  /(credential|secret|\/tokens?(\/|$)|access-tokens|service-principals|mcp-grants|test-decrypt|webhook\/regenerate|\/config\/(github|slack|issue-tracker|knowledge-base|figma)$)/;
const IDENTITY_WRITE_PATHS =
  /^\/api\/v1\/(users|platform\/sessions|platform\/config\/grants)(\/|$)|\/members(\/|$)/;
const HUMAN_DECISIONS =
  /^\/api\/v1\/(human-steps\/:id\/respond|assistant\/actions\/:id\/(confirm|decline))$/;

interface Route {
  method: string;
  url: string;
}

let routes: Route[] = [];

beforeAll(async () => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Registration reads none of these; handlers would, and none runs here.
  for (const name of ['prisma', 'temporal', 'auth', 'mcpBridge']) {
    app.decorate(name, {} as never);
  }
  const seen: Route[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (
        method !== 'HEAD' &&
        method !== 'OPTIONS' &&
        (route.url.startsWith('/api/v1/') || route.url === '/api/auth/device/code')
      ) {
        seen.push({ method, url: route.url });
      }
    }
  });
  await registerApiRoutes(app);
  // The auth wildcard is registered by the gateway bootstrap; include the new explicit
  // rate-limited device-code route in this policy walk without importing auth's DB singleton.
  seen.push({ method: 'POST', url: '/api/auth/device/code' });
  await app.ready();
  await app.close();
  routes = seen;
}, 60_000);

const decided = () =>
  routes.filter((r) => r.method !== 'DELETE' && !RECEIVERS.test(r.url) && !ALIASES.test(r.url));

describe('assistant route policy', () => {
  it('walks a realistic route table', () => {
    expect(decided().length).toBeGreaterThan(250);
  });

  it('has a decision for every route the assistant could reach', () => {
    const missing = decided()
      .map((r) => policyKey(r.method, r.url))
      .filter((key) => ASSISTANT_ROUTE_POLICY[key] === undefined);
    expect(missing, 'add each route to ASSISTANT_ROUTE_POLICY with a decision').toEqual([]);
  });

  it('names no route that does not exist', () => {
    const registered = new Set(routes.map((r) => policyKey(r.method, r.url)));
    const stale = Object.keys(ASSISTANT_ROUTE_POLICY).filter((key) => !registered.has(key));
    expect(stale).toEqual([]);
  });

  it('lists no DELETE and no deprecated alias, which are refused by having no entry', () => {
    const listed = Object.keys(ASSISTANT_ROUTE_POLICY).filter(
      (key) => key.startsWith('DELETE ') || ALIASES.test(key.slice(key.indexOf(' ') + 1))
    );
    expect(listed).toEqual([]);
  });

  it('treats a non-GET as a read only with a stated reason, and a GET only as a plain read', () => {
    const wrong = Object.entries(ASSISTANT_ROUTE_POLICY).filter(([key, entry]) => {
      const isGet = key.startsWith('GET ');
      if (entry === 'read') {
        return !isGet;
      }
      if (entry === 'confirm') {
        return isGet;
      }
      return 'read' in entry && (isGet || entry.read.trim().length < 10);
    });
    expect(wrong).toEqual([]);
  });

  it('refuses every route that touches a secret or credential', () => {
    const exposed = decided()
      .filter((r) => SECRET_PATHS.test(r.url))
      .filter((r) => assistantAccess(r.method, r.url) !== 'never')
      .map((r) => policyKey(r.method, r.url));
    expect(exposed).toEqual([]);
  });

  it('refuses every change to users, memberships, grants or sessions', () => {
    const exposed = decided()
      .filter((r) => r.method !== 'GET' && IDENTITY_WRITE_PATHS.test(r.url))
      .filter((r) => assistantAccess(r.method, r.url) !== 'never')
      .map((r) => policyKey(r.method, r.url));
    expect(exposed).toEqual([]);
  });

  it('refuses the decisions a person makes', () => {
    const decisions = decided().filter((r) => HUMAN_DECISIONS.test(r.url));
    expect(decisions.length).toBe(3);
    for (const r of decisions) {
      expect(assistantAccess(r.method, r.url), policyKey(r.method, r.url)).toBe('never');
    }
  });
});

describe('assistantAccess', () => {
  it('refuses DELETE, an unknown route and a missing pattern', () => {
    expect(assistantAccess('DELETE', '/api/v1/workflow-runs/:id')).toBe('never');
    expect(assistantAccess('GET', '/api/v1/nope')).toBe('never');
    expect(assistantAccess('GET', undefined)).toBe('never');
  });

  it('judges HEAD as the GET it mirrors', () => {
    expect(assistantAccess('HEAD', '/api/v1/workflow-runs/:id')).toBe('read');
  });

  it('reads the reasoned and refused forms', () => {
    expect(assistantAccess('POST', '/api/v1/workflow-templates/validate')).toBe('read');
    expect(assistantAccess('POST', '/api/v1/work-requests')).toBe('confirm');
    expect(assistantAccess('POST', '/api/v1/human-steps/:id/respond')).toBe('never');
  });
});

describe('policyPatternFor', () => {
  it('prefers a static segment over a parameter', () => {
    expect(policyPatternFor('POST', '/api/v1/workflow-templates/validate')).toBe(
      '/api/v1/workflow-templates/validate'
    );
    expect(policyPatternFor('PATCH', '/api/v1/workflow-templates/abc')).toBe(
      '/api/v1/workflow-templates/:id'
    );
  });

  it('ignores the query and refuses an empty segment', () => {
    expect(policyPatternFor('POST', '/api/v1/work-requests?x=1')).toBe('/api/v1/work-requests');
    expect(policyPatternFor('PATCH', '/api/v1/workflow-templates/')).toBeUndefined();
  });

  it('finds nothing for a method the path is not registered under', () => {
    expect(policyPatternFor('PUT', '/api/v1/work-requests')).toBeUndefined();
  });
});
