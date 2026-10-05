import { humanizeKey } from '@/lib/govLabels';
import { requestHref } from '@/lib/requestDisplay';

/** Where an audited entity can be opened: its own page when it has one, else its list. */
interface EntityTarget {
  /** A page for this one entity. */
  byId?: (id: string) => string;
  /** The page that lists entities of this type. */
  list?: string;
}

const TARGETS: Record<string, EntityTarget> = {
  Agent: { list: '/studio/agents/library' },
  AutonomyPolicy: { list: '/govern/policies' },
  ConfigPermission: { list: '/govern/config-grants' },
  ConfigSetting: { list: '/govern/platform-settings' },
  Organization: { byId: (id) => `/govern/organizations/${id}` },
  PersonalAccessToken: { list: '/govern/api-tokens' },
  ScannerPattern: { list: '/govern/scanner' },
  ScheduledWorkRequest: { list: '/govern/schedules' },
  Session: { list: '/govern/sessions' },
  Skill: { list: '/studio/skills' },
  SlackChannel: { byId: (id) => `/govern/slack-channels/${id}` },
  Team: { byId: (id) => `/govern/teams/${id}` },
  User: { list: '/govern/users' },
  WorkflowDefaults: { list: '/govern/workflow-defaults' },
  WorkflowRun: { byId: (id) => `/runs/${id}` },
};

/** A plain name for an entity type: `PersonalAccessToken` → "Personal access token". */
export function entityTypeLabel(entityType: string): string {
  return humanizeKey(entityType);
}

/**
 * The best page to open for an audited entity, or null when none exists. A run opens its
 * request panel when the log could resolve the request, else the run's diagnostics page.
 */
export function entityHref(
  entityType: string,
  entityId: string,
  workRequestId?: string | null
): string | null {
  if (entityType === 'WorkflowRun' && workRequestId) {
    return requestHref(workRequestId);
  }
  const target = TARGETS[entityType];
  if (!target) {
    return null;
  }
  return target.byId ? target.byId(entityId) : (target.list ?? null);
}
