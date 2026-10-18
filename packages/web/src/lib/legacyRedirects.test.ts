import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { prepareDestination } from 'next/dist/shared/lib/router/utils/prepare-destination';
import { describe, expect, it } from 'vitest';
import nextConfig, { LEGACY_REDIRECTS } from '../../next.config';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');

/** Every page route in the app, with `[param]` segments kept. */
function appRoutes(dir = APP_DIR, url = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isFile()) {
      return entry.name === 'page.tsx' ? [url || '/'] : [];
    }
    return entry.isDirectory() ? appRoutes(join(dir, entry.name), `${url}/${entry.name}`) : [];
  });
}

const ROUTES = appRoutes();

/** Does an app page serve `pathname`? A `[param]` segment matches any one segment. */
function served(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  return ROUTES.some((route) => {
    const rp = route.split('/').filter(Boolean);
    return (
      rp.length === parts.length && rp.every((seg, i) => seg.startsWith('[') || seg === parts[i])
    );
  });
}

/**
 * Where Next sends `url`: the first rule whose source matches, its destination filled from the
 * matched params, the request's query carried over — the same helpers and options Next's own
 * router uses for `redirects()`. Null when no rule matches.
 */
function redirectOf(url: string): string | null {
  const parsed = new URL(url, 'http://dashboard.test');
  const query = Object.fromEntries(parsed.searchParams);
  for (const rule of LEGACY_REDIRECTS) {
    const params = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true })(
      parsed.pathname
    );
    if (!params) {
      continue;
    }
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: rule.destination,
      params,
      query,
    });
    const search = new URLSearchParams(
      Object.entries(parsedDestination.query).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((one) => [k, String(one)])
      )
    ).toString();
    return `${parsedDestination.pathname}${search ? `?${search}` : ''}`;
  }
  return null;
}

/** Every address that moved, with a deep link and a query string where the old page had one. */
const MOVED: [string, string][] = [
  ['/workflows', '/requests'],
  ['/workflows?scope=team&state=failed', '/requests?scope=team&state=failed'],
  ['/workflows?request=wr-1', '/requests?request=wr-1'],
  [
    '/workflows/0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab',
    '/requests/0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab',
  ],
  ['/workflows/library', '/library'],
  ['/workflows/library?view=mine', '/library?view=mine'],
  ['/workflows/library/tpl-1', '/library/tpl-1'],
  ['/workflows/library/tpl-1/diff?from=2&to=3', '/library/tpl-1/diff?from=2&to=3'],
  ['/workflows/library/tpl-1/runs', '/library/tpl-1/runs'],
  ['/workflows/library/tpl-1/analytics', '/library/tpl-1/analytics'],
  ['/govern/approvals', '/approvals'],
  ['/govern/approvals?x=y', '/approvals?x=y'],
  ['/inbox', '/approvals'],
  ['/studio/agents/library', '/agents'],
  ['/studio/agents/library?agent=implementer', '/agents?agent=implementer'],
  ['/studio/skills', '/skills'],
  ['/studio/models?tab=credentials', '/models?tab=credentials'],
  ['/studio/mcp', '/mcp'],
  ['/studio/bundles', '/bundles'],
  [
    '/studio/integrations?tab=slack&slack_installed=T1',
    '/admin/integrations?tab=slack&slack_installed=T1',
  ],
  ['/studio/github-installations', '/admin/github-installations'],
  ['/govern/budget-alerts', '/admin/organizations?alerting=1'],
  ['/govern', '/admin'],
  ['/govern/users', '/admin/users'],
  ['/govern/teams/t-1', '/admin/teams/t-1'],
  ['/govern/organizations/o-1', '/admin/organizations/o-1'],
  ['/govern/sessions', '/admin/sessions'],
  ['/govern/api-tokens', '/admin/api-tokens'],
  ['/govern/scanner', '/admin/scanner'],
  ['/govern/policies', '/admin/policies'],
  ['/govern/policies/decisions?team=t-1', '/admin/policies/decisions?team=t-1'],
  ['/govern/security', '/admin/security'],
  ['/govern/audit?entity=Agent', '/admin/audit?entity=Agent'],
  ['/govern/analytics', '/admin/analytics'],
  ['/govern/usage', '/admin/usage'],
  ['/govern/assistant', '/admin/assistant'],
  ['/govern/platform-settings', '/admin/platform-settings'],
  ['/govern/workflow-defaults', '/admin/workflow-defaults'],
  ['/govern/config-grants', '/admin/config-grants'],
  ['/govern/automations', '/admin/automations'],
  ['/govern/schedules', '/admin/schedules'],
  ['/govern/slack-channels/c-1', '/admin/slack-channels/c-1'],
  ['/govern/lessons', '/lessons'],
  ['/govern/knowledge', '/knowledge'],
  ['/admin/lessons', '/lessons'],
  ['/admin/knowledge', '/knowledge'],
  ['/govern/baselines', '/admin/baselines'],
  ['/govern/evals', '/admin/evals'],
  ['/govern/evals/runs/r-1', '/admin/evals/runs/r-1'],
  ['/govern/evals/datasets/d-1', '/admin/evals/datasets/d-1'],
];

describe('legacy redirects', () => {
  it.each(MOVED)('%s → %s', (from, to) => {
    expect(redirectOf(from)).toBe(to);
    expect(served(to.split('?')[0]), `${to} is not a page`).toBe(true);
  });

  it('is registered with Next as permanent redirects', async () => {
    const rules = await nextConfig.redirects?.();
    expect(rules).toHaveLength(LEGACY_REDIRECTS.length);
    for (const rule of rules ?? []) {
      expect(rule).toMatchObject({ permanent: true });
    }
  });

  it('never shadows a page that exists today', () => {
    for (const route of ROUTES) {
      const concrete = route.replace(/\[[^\]]+\]/g, 'x');
      expect(redirectOf(concrete), route).toBeNull();
    }
  });

  it('sends every rule to a page that exists', () => {
    for (const rule of LEGACY_REDIRECTS) {
      const example = rule.source.replace(/\/:path\*$/, '/x');
      const to = redirectOf(example);
      expect(to, rule.source).not.toBeNull();
      // A `:path*` rule sends `/x` on to its new prefix: check the prefix itself is a page.
      const target = rule.source.endsWith(':path*')
        ? rule.destination.replace(/\/:path\*$/, '')
        : (to ?? '').split('?')[0];
      expect(served(target), `${rule.source} → ${target}`).toBe(true);
    }
  });
});
