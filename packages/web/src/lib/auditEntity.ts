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
  ActiveWorkflow: { list: '/runs' },
  Agent: { list: '/agents' },
  Automation: { list: '/admin/automations' },
  AutonomyPolicy: { list: '/admin/policies' },
  ConfigPermission: { list: '/admin/config-grants' },
  ConfigSetting: { list: '/admin/platform-settings' },
  EvalRun: { byId: (id) => `/admin/evals/runs/${id}` },
  Organization: { byId: (id) => `/admin/organizations/${id}` },
  PersonalAccessToken: { list: '/admin/api-tokens' },
  ScannerPattern: { list: '/admin/scanner' },
  ScheduledWorkRequest: { list: '/admin/schedules' },
  Session: { list: '/admin/sessions' },
  Skill: { list: '/skills' },
  SlackChannel: { byId: (id) => `/admin/slack-channels/${id}` },
  Team: { byId: (id) => `/admin/teams/${id}` },
  User: { list: '/admin/users' },
  WorkflowDefaults: { list: '/admin/workflow-defaults' },
  WorkflowRun: { byId: (id) => `/runs/${id}` },
  WorkRequest: { byId: (id) => requestHref(id) },
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
