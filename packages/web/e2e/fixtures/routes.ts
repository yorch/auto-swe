import type { UsageScopes } from '../../src/hooks/useAdmin';
import {
  ACCESS_TOKENS,
  AUTH_PROVIDERS,
  CREDENTIALS,
  LINKED_ACCOUNTS,
  MCP_GRANTS,
  MODEL_CATALOG,
  MY_CREDENTIALS,
  PATS,
  READINESS,
  ROLE_PRICING,
  TEMPLATE_ANALYTICS,
  USERS,
} from './admin';
import { page, REPOSITORIES, TEAMS } from './common';
import { RUN_DETAIL, RUN_LESSONS } from './runDetail';
import { STEP_REGISTRY, TEMPLATE_DETAIL, TEMPLATES } from './templates';
import { APPROVALS, PULL_REQUESTS, RUNS, requestsInState } from './work';

/** One answered gateway call: a GET (unless `method` says otherwise) whose path matches. */
export interface FixtureRoute {
  method?: string;
  path: string | RegExp;
  respond: (url: URL, match: RegExpMatchArray | null) => unknown;
}

/** The gateway's text filters: a case-insensitive substring match. */
const matches = (text: string | null | undefined, query: string) =>
  (text ?? '').toLowerCase().includes(query.toLowerCase());

const USAGE_SCOPES: UsageScopes = { orgs: [], platform: true, teams: [] };

export const ROUTES: FixtureRoute[] = [
  // Chrome: every page's shell.
  { path: '/api/v1/assistant/status', respond: () => ({ data: { enabled: true } }) },
  { path: '/api/v1/platform/usage/scopes', respond: () => ({ data: USAGE_SCOPES }) },
  { path: '/api/v1/teams', respond: () => ({ data: TEAMS }) },
  { path: '/api/v1/repositories', respond: () => page(REPOSITORIES) },

  // Work.
  {
    path: '/api/v1/workflow-runs/requests',
    respond: (url) => {
      const search = url.searchParams.get('search');
      const rows = requestsInState(url.searchParams.get('state')).filter(
        (r) => !search || matches(r.workRequest?.title, search)
      );
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return page(rows.slice(0, limit), rows.length);
    },
  },
  { path: '/api/v1/me/preferences', respond: () => ({ preferences: { runDetailLayout: 'A' } }) },
  { path: /^\/api\/v1\/workflow-runs\/run-[^/]+$/, respond: () => ({ data: RUN_DETAIL }) },
  {
    path: /^\/api\/v1\/workflow-runs\/run-[^/]+\/lessons$/,
    respond: () => ({ data: RUN_LESSONS }),
  },
  {
    path: /^\/api\/v1\/workflow-runs\/run-[^/]+\/traces$/,
    respond: () => ({
      data: [],
      serverTime: '2026-10-17T09:00:00.000Z',
      total: RUN_DETAIL.traces.length,
      truncated: false,
    }),
  },
  {
    path: /^\/api\/v1\/workflow-runs\/run-[^/]+\/callback-deliveries$/,
    respond: () => ({ data: { deliveries: [], target: null } }),
  },
  { path: /^\/api\/v1\/workflow-runs\/run-[^/]+\/eval-results$/, respond: () => ({ data: [] }) },
  {
    path: /^\/api\/v1\/workflow-runs\/run-[^/]+\/autonomy-decisions$/,
    respond: () => ({ data: [] }),
  },
  {
    path: '/api/v1/workflow-runs',
    respond: (url) => {
      const status = url.searchParams.get('status');
      const q = url.searchParams.get('q');
      const rows = RUNS.filter(
        (r) => (!status || r.status === status) && (!q || matches(r.workRequest?.title, q))
      );
      return page(rows);
    },
  },
  {
    path: '/api/v1/pull-requests',
    respond: (url) => {
      const state = url.searchParams.get('state');
      const rows = PULL_REQUESTS.filter((pr) => !state || state === 'all' || pr.status === state);
      return page(rows);
    },
  },
  {
    path: '/api/v1/human-steps',
    respond: (url) => {
      const all = url.searchParams.get('status') === 'ALL';
      const runId = url.searchParams.get('runId');
      const rows = APPROVALS.filter(
        (s) => (all || s.status === 'PENDING') && (!runId || s.runId === runId)
      );
      if (url.searchParams.get('answeredByMe') === 'true') {
        return page([], 3);
      }
      return page(rows);
    },
  },

  // Build.
  {
    path: '/api/v1/workflow-templates',
    respond: (url) => {
      const q = url.searchParams.get('q');
      return { data: TEMPLATES.filter((t) => !q || matches(t.name, q)) };
    },
  },
  { path: /^\/api\/v1\/workflow-templates\/[^/]+$/, respond: () => ({ data: TEMPLATE_DETAIL }) },
  {
    path: /^\/api\/v1\/workflow-templates\/[^/]+\/versions\/\d+$/,
    respond: () => ({ data: TEMPLATE_DETAIL.activeVersionSpec }),
  },
  {
    path: /^\/api\/v1\/workflow-templates\/[^/]+\/analytics$/,
    respond: () => ({ data: TEMPLATE_ANALYTICS }),
  },
  { path: '/api/v1/platform/model-catalog/role-pricing', respond: () => ({ data: ROLE_PRICING }) },
  { path: '/api/v1/workflow-steps/registry', respond: () => ({ data: STEP_REGISTRY }) },

  // Admin and settings.
  { path: '/api/v1/platform/readiness', respond: () => ({ data: READINESS }) },
  { path: '/api/v1/platform/credentials', respond: () => ({ data: CREDENTIALS }) },
  { path: '/api/v1/platform/model-catalog', respond: () => ({ data: MODEL_CATALOG }) },
  { path: '/api/v1/platform/model-catalog/unpriced', respond: () => ({ data: [] }) },
  {
    path: '/api/v1/platform/model-catalog/suggestions',
    respond: () => ({
      data: {
        hiddenDismissed: { NEW: 0, RETIREMENT_CANDIDATE: 0 },
        providers: [],
        suggestions: [],
      },
    }),
  },
  { path: '/api/v1/users', respond: () => ({ data: USERS }) },
  { path: '/api/v1/platform/access-tokens', respond: () => ({ data: ACCESS_TOKENS }) },
  { path: '/api/v1/auth/tokens', respond: () => ({ data: PATS }) },
  { path: '/api/v1/repositories/credentials/mine', respond: () => ({ data: MY_CREDENTIALS }) },
  { path: '/api/v1/me/mcp-grants', respond: () => MCP_GRANTS },
  { path: '/api/v1/auth/providers', respond: () => AUTH_PROVIDERS },
  { path: '/api/auth/list-accounts', respond: () => LINKED_ACCOUNTS },
];

export function findRoute(method: string, url: URL) {
  for (const route of ROUTES) {
    if ((route.method ?? 'GET') !== method) {
      continue;
    }
    if (typeof route.path === 'string') {
      if (route.path === url.pathname) {
        return { match: null, route };
      }
    } else {
      const match = url.pathname.match(route.path);
      if (match) {
        return { match, route };
      }
    }
  }
  return null;
}
