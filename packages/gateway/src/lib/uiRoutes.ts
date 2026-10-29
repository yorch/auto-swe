/**
 * The dashboard's page routes, as Next.js route templates (`/runs/[id]`), for the page-view
 * events. This list is the only thing a UI event may name: a path that matches none of these is
 * dropped, so a stray id, slug or query string can never reach the table.
 *
 * It mirrors `packages/web/src/app/**\/page.tsx`; `uiRoutes.test.ts` globs that tree and fails when
 * a page is added, removed or renamed without this list following.
 */
export const UI_ROUTE_TEMPLATES: readonly string[] = [
  '/',
  '/admin',
  '/admin/activity',
  '/admin/analytics',
  '/admin/api-tokens',
  '/admin/assistant',
  '/admin/audit',
  '/admin/automations',
  '/admin/baselines',
  '/admin/config-grants',
  '/admin/evals',
  '/admin/evals/datasets/[id]',
  '/admin/evals/runs/[id]',
  '/admin/github-installations',
  '/admin/integrations',
  '/admin/organizations',
  '/admin/organizations/[orgId]',
  '/admin/platform-settings',
  '/admin/policies',
  '/admin/policies/decisions',
  '/admin/reports',
  '/admin/scanner',
  '/admin/schedules',
  '/admin/security',
  '/admin/sessions',
  '/admin/slack-channels',
  '/admin/slack-channels/[id]',
  '/admin/teams',
  '/admin/teams/[id]',
  '/admin/usage',
  '/admin/users',
  '/admin/workflow-defaults',
  '/agent-runs',
  '/agents',
  '/approvals',
  '/bundles',
  '/connections',
  '/device',
  '/docs',
  '/docs/[slug]',
  '/epics',
  '/epics/[workflowId]',
  '/knowledge',
  '/lessons',
  '/library',
  '/library/[id]',
  '/library/[id]/analytics',
  '/library/[id]/diff',
  '/library/[id]/runs',
  '/login',
  '/mcp',
  '/models',
  '/oauth/consent',
  '/pull-requests',
  '/requests',
  '/requests/[id]',
  '/reset-password',
  '/runs',
  '/runs/[id]',
  '/settings',
  '/skills',
  '/start',
  '/tickets',
];

const MAX_PATH_LENGTH = 200;

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x20) {
      return true;
    }
  }
  return false;
}

/** One regex per template: a `[param]` segment matches any single non-empty segment. */
const MATCHERS = UI_ROUTE_TEMPLATES.map((template) => ({
  // Static segments rank above dynamic ones, so `/admin/users` wins over a hypothetical `/admin/[x]`.
  dynamic: (template.match(/\[/g) ?? []).length,
  regex: new RegExp(
    `^${template
      .split('/')
      .map((segment) =>
        segment.startsWith('[') ? '[^/]+' : segment.replace(/[.*+?^${}()|\\]/g, '\\$&')
      )
      .join('/')}$`
  ),
  template,
})).sort((a, b) => a.dynamic - b.dynamic);

/**
 * The route template a page path belongs to, or `null` when it matches none. A path with a query
 * string, fragment, `..`, or a control character is refused outright rather than trimmed, so a
 * client that sends more than a path is dropped, not half-recorded. A trailing slash is ignored.
 */
export function uiRouteTemplate(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || !path.startsWith('/')) {
    return null;
  }
  if (/[?#\\]/.test(path) || hasControlCharacter(path) || path.split('/').includes('..')) {
    return null;
  }
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return MATCHERS.find((m) => m.regex.test(normalized))?.template ?? null;
}
