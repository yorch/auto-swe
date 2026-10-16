import type {
  AssistantPageContext,
  AssistantPageEntityType,
} from '@auto-swe/shared/lib/assistantConversation';

/**
 * The page a message is sent from, as the assistant's `getPageContext` tool reports it: the route,
 * and the entity the page shows when it shows one. Only the dashboard's own detail routes are
 * recognised; anything else sends the route alone.
 */

const ENTITY_ROUTES: ReadonlyArray<[RegExp, AssistantPageEntityType]> = [
  [/^\/runs\/([^/]+)$/, 'run'],
  [/^\/library\/([^/]+)(?:\/.*)?$/, 'template'],
  [/^\/requests\/([^/]+)$/, 'workflow'],
  [/^\/epics\/([^/]+)$/, 'epic'],
  [/^\/admin\/teams\/([^/]+)$/, 'team'],
  [/^\/admin\/organizations\/([^/]+)$/, 'organization'],
  [/^\/admin\/evals\/runs\/([^/]+)$/, 'evalRun'],
  [/^\/admin\/evals\/datasets\/([^/]+)$/, 'evalDataset'],
  [/^\/docs\/(?!search$)([^/]+)$/, 'doc'],
];

const ENTITY_ID_RE = /^[A-Za-z0-9._:@-]{1,200}$/;
const MAX_ROUTE_CHARS = 300;

export function pageContextFor(pathname: string): AssistantPageContext {
  const route = pathname.split(/[?#]/)[0]?.slice(0, MAX_ROUTE_CHARS) || '/';
  for (const [pattern, entityType] of ENTITY_ROUTES) {
    const raw = pattern.exec(route)?.[1];
    if (!raw) {
      continue;
    }
    let entityId: string;
    try {
      entityId = decodeURIComponent(raw);
    } catch {
      break;
    }
    if (ENTITY_ID_RE.test(entityId)) {
      return { entityId, entityType, route };
    }
    break;
  }
  return { route };
}
