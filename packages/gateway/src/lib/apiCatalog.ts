import { z } from 'zod';
import { assistantAccess } from './assistantPolicy.js';

/**
 * The gateway's API as the in-app assistant's `describeApi` tool sees it: every registered `/api/v1`
 * route the assistant may call (`assistantPolicy.ts`), with the JSON Schema of its path parameters,
 * query string and body, taken from the route's own Zod schemas. Built from the route table rather
 * than written down, so it cannot describe a route that does not exist or miss one that does.
 *
 * It lists only what the policy admits, and admission is checked again by `requireAuth` on the call
 * itself, so the catalog is a map, not a permission.
 */

export interface ApiCatalogEntry {
  method: string;
  path: string;
  /** `read`: callable now. `confirm`: only with the user's confirmation of the exact request. */
  access: 'read' | 'confirm';
  params?: unknown;
  query?: unknown;
  body?: unknown;
}

interface RecordedRoute {
  method: string;
  path: string;
  access: 'read' | 'confirm';
  schema: { params?: unknown; querystring?: unknown; body?: unknown };
  /** Lower-cased path and schema text, built on first search. */
  haystack?: { path: string; schema: string };
  described?: ApiCatalogEntry;
}

/** Longest JSON Schema kept for one part of one route; a larger one is replaced by a note. */
const MAX_SCHEMA_CHARS = 2500;

/** JSON Schema for a route schema part: a Zod schema converts, a plain JSON Schema passes through. */
function jsonSchemaOf(part: unknown): unknown {
  if (part === undefined || part === null) {
    return undefined;
  }
  let schema: unknown = part;
  if (part instanceof z.ZodType) {
    try {
      schema = z.toJSONSchema(part, { io: 'input', unrepresentable: 'any' });
    } catch {
      return { description: 'not describable' };
    }
  }
  if (schema && typeof schema === 'object' && '$schema' in schema) {
    const { $schema: _, ...rest } = schema as Record<string, unknown>;
    schema = rest;
  }
  return JSON.stringify(schema).length > MAX_SCHEMA_CHARS
    ? { description: 'large schema omitted; read the route with sensible defaults first' }
    : schema;
}

export class ApiCatalog {
  private readonly routes: RecordedRoute[] = [];

  /** Record a route as Fastify registers it. Routes the assistant may never call are skipped. */
  add(route: { method: string | string[]; url: string; schema?: unknown }): void {
    if (!route.url.startsWith('/api/v1/')) {
      return;
    }
    for (const method of [route.method].flat()) {
      const access = assistantAccess(method, route.url);
      if (access === 'never') {
        continue;
      }
      const schema = (route.schema ?? {}) as RecordedRoute['schema'];
      this.routes.push({ access, method, path: route.url, schema });
    }
  }

  get size(): number {
    return this.routes.length;
  }

  /**
   * The routes best matching `query`, best first: a term in the path counts more than one in the
   * schemas; on a tie GET routes come before writes, and shorter paths (the collection) before
   * longer ones. An empty query lists the first `limit`.
   */
  search(query: string, limit: number): ApiCatalogEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[\s/,]+/)
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    const scored = this.routes.map((route, order) => {
      route.haystack ??= {
        path: route.path.toLowerCase(),
        schema: JSON.stringify(this.describe(route)).toLowerCase(),
      };
      let score = 0;
      for (const term of terms) {
        const stem = term.length > 4 ? term.replace(/(es|s|ed|ing)$/, '') : term;
        if (route.haystack.path.includes(stem)) {
          score += 3;
        } else if (route.haystack.schema.includes(stem)) {
          score += 1;
        }
      }
      return { order, route, score };
    });
    return scored
      .filter((s) => terms.length === 0 || s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.route.method === 'GET') - Number(a.route.method === 'GET') ||
          a.route.path.length - b.route.path.length ||
          a.order - b.order
      )
      .slice(0, limit)
      .map((s) => this.describe(s.route));
  }

  private describe(route: RecordedRoute): ApiCatalogEntry {
    if (!route.described) {
      const params = jsonSchemaOf(route.schema.params);
      const query = jsonSchemaOf(route.schema.querystring);
      const body = route.method === 'GET' ? undefined : jsonSchemaOf(route.schema.body);
      route.described = {
        access: route.access,
        method: route.method,
        path: route.path,
        ...(params === undefined ? {} : { params }),
        ...(query === undefined ? {} : { query }),
        ...(body === undefined ? {} : { body }),
      };
    }
    return route.described;
  }
}
