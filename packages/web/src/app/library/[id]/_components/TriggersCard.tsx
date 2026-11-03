import { eventSource } from '@auto-swe/shared/automation';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { type AutomationSummary, useAllAutomations } from '@/hooks/useAutomations';
import { useSchedules } from '@/hooks/useSchedules';
import { errMsg } from '@/lib/errors';
import { RailCard } from './RailCard';

interface TriggerRow {
  key: string;
  kind: 'Event' | 'Schedule';
  name: string;
  when: string;
  enabled: boolean;
  owner: string | null;
}

function ownerOf(r: {
  repository: { organizationName: string | null; repoName: string | null } | null;
  team: { name: string } | null;
}): string | null {
  const repo = r.repository ? [r.repository.organizationName, r.repository.repoName] : null;
  return repo?.filter(Boolean).join('/') || r.team?.name || null;
}

interface TriggersTemplate {
  id: string;
  name: string;
  status: string;
  team: { id: string } | null;
}

/** An event automation starts this template when it names it, or names none and the source's
 *  default template is this one (matched by name; the default is a built-in, not a row id). The engine resolves
 *  defaults only among global ACTIVE templates, so a team template of the same name never matches. */
function startsTemplate(row: AutomationSummary, template: TriggersTemplate): boolean {
  if (row.kind !== 'event') {
    return false;
  }
  if (row.template) {
    return row.template.id === template.id;
  }
  if (template.team !== null || template.status !== 'ACTIVE') {
    return false;
  }
  const defaultName = row.source ? eventSource(row.source)?.defaultTemplate?.name : undefined;
  return defaultName !== undefined && defaultName === template.name;
}

/**
 * Read-only answer to "what starts this template?": the event automations and cron schedules
 * that name it, and a pointer to the webhook card. The lists come from the endpoints the
 * Automations page uses, so they hold only what the caller may see.
 */
export function TriggersCard({
  template,
  webhookConfigured,
}: {
  template: TriggersTemplate;
  webhookConfigured: boolean;
}) {
  const all = useAllAutomations();
  const schedules = useSchedules();

  const rows: TriggerRow[] = [
    ...(all.data ?? [])
      .filter((r) => startsTemplate(r, template))
      .map((r) => ({
        enabled: r.enabled,
        key: `event-${r.id}`,
        kind: 'Event' as const,
        name: r.name,
        owner: ownerOf(r),
        when: r.when,
      })),
    ...(schedules.data ?? [])
      .filter((s) => s.template?.id === template.id)
      .map((s) => ({
        enabled: s.isActive && !s.schedule.paused && s.schedule.exists !== false,
        key: `schedule-${s.id}`,
        kind: 'Schedule' as const,
        name: s.name,
        owner: ownerOf(s),
        when: `On a schedule: ${s.cronExpression} (UTC)`,
      })),
  ];

  const loading = all.isLoading || schedules.isLoading;

  return (
    <RailCard hint="what starts it" title="Triggers">
      {loading ? (
        <p className="text-xs text-paper-500">Loading triggers…</p>
      ) : (
        <div className="space-y-3">
          {all.error && (
            <Alert className="text-xs">
              {errMsg(all.error, 'Could not load event automations')}
            </Alert>
          )}
          {schedules.error && (
            <Alert className="text-xs">{errMsg(schedules.error, 'Could not load schedules')}</Alert>
          )}
          {rows.length === 0 && !webhookConfigured ? (
            <p className="text-xs leading-relaxed text-paper-500">
              Nothing starts this template automatically yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li className="text-sm text-paper-200" key={r.key}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral" variant="outline">
                      {r.kind}
                    </Badge>
                    <span className="font-medium">{r.name}</span>
                    <Badge dot tone={r.enabled ? 'success' : 'warning'}>
                      {r.enabled ? 'Enabled' : 'Off'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-paper-500">
                    {r.when}
                    {r.owner ? ` · ${r.owner}` : ''}
                  </p>
                </li>
              ))}
              {webhookConfigured && (
                <li className="text-sm text-paper-200">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral" variant="outline">
                      Webhook
                    </Badge>
                    <span>Signed webhook URL exists</span>
                  </div>
                  <p className="mt-1 text-xs text-paper-500">
                    Managed in the Webhook trigger card.
                  </p>
                </li>
              )}
            </ul>
          )}
          <p className="text-xs leading-relaxed text-paper-500">
            Event sources can be switched off platform-wide in{' '}
            <Link className="text-accent-400 hover:underline" href="/admin/platform-settings">
              Platform settings
            </Link>
            ; a listed automation fires only while its source is on.
          </p>
          <p className="flex gap-3 text-xs">
            <Link className="text-accent-400 hover:underline" href="/admin/automations">
              Manage automations
            </Link>
            <Link className="text-accent-400 hover:underline" href="/admin/schedules">
              Manage schedules
            </Link>
          </p>
        </div>
      )}
    </RailCard>
  );
}
