'use client';

import Link from 'next/link';
import { useAdminPages } from '@/components/layout/AdminNav';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon, isIconName } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { useOrganizationDirectory } from '@/hooks/useAdmin';
import { useUsers } from '@/hooks/useUsers';
import { ADMIN_HREF, navLabel, navSections } from '@/lib/navigation';
import { cn, FOCUS_RING, plural } from '@/lib/utils';

/** One line on what each Admin page is for, so a label like "Baselines" is not a guess. */
const PAGE_DESCRIPTIONS: Record<string, string> = {
  '/admin/activity': 'What people have been doing in the dashboard.',
  '/admin/analytics': 'Trends across runs, cost and outcomes.',
  '/admin/api-tokens': 'Every personal and service-principal token; revoke any of them.',
  '/admin/assistant': 'Where the in-app assistant failed to answer.',
  '/admin/audit': 'The record of who changed what, and when.',
  '/admin/automations': 'Rules that start runs on schedules and events.',
  '/admin/baselines': 'Known error patterns, so new failures stand out.',
  '/admin/config-grants': 'Let a role or person change specific platform settings.',
  '/admin/evals': 'Evaluation runs for agents and workflows.',
  '/admin/github-installations': 'Where the GitHub App is installed, per organization and host.',
  '/admin/integrations': 'Credentials for GitHub, Slack, trackers, knowledge bases and Figma.',
  '/admin/organizations': 'Organizations, their members and monthly budgets.',
  '/admin/platform-settings': 'Operator policy settings, by scope.',
  '/admin/policies': 'Rules for what agents may do without a human.',
  '/admin/policies/decisions': 'Each autonomy decision and the reason behind it.',
  '/admin/reports': 'Reports and scheduled digests.',
  '/admin/scanner': 'Security scanner patterns that block or flag agent actions.',
  '/admin/security': 'Events raised by the security scanners.',
  '/admin/sessions': 'Browser sessions that are signed in; sign people out.',
  '/admin/slack-channels': 'Channels the assistant answers in, with their spend.',
  '/admin/teams': 'Team members, repositories, sandbox policy and agent overrides.',
  '/admin/usage': 'Model spend and token usage.',
  '/admin/users': 'Invite people, approve sign-ups, set roles, suspend accounts.',
  '/admin/workflow-defaults': 'Branch prefix, templates, budgets and iteration limits.',
};

/** A count the page already holds, shown as a badge on its card. Admin-only: the directory is. */
function UsersSignal() {
  const { data } = useUsers();
  const waiting = (data ?? []).filter((u) => !u.isActive).length;
  return waiting > 0 ? (
    <Badge dot tone="warning">
      {waiting} awaiting approval
    </Badge>
  ) : null;
}

function OrganizationsSignal() {
  const { data } = useOrganizationDirectory();
  const alerting = (data ?? []).filter((o) => o.alert.triggered).length;
  return alerting > 0 ? (
    <Badge dot tone="warning">
      {alerting} over budget alert
    </Badge>
  ) : null;
}

function Signal({
  href,
  hasUsers,
  hasOrgs,
}: {
  href: string;
  hasUsers: boolean;
  hasOrgs: boolean;
}) {
  if (href === '/admin/users' && hasUsers) {
    return <UsersSignal />;
  }
  if (href === '/admin/organizations' && hasOrgs) {
    return <OrganizationsSignal />;
  }
  return null;
}

/** The Admin area's landing page: every Admin page the user may open, by section. */
export default function AdminOverviewPage() {
  const pages = useAdminPages();
  const hrefs = new Set(pages.map((p) => p.href));
  const sections = navSections(pages);
  const lone = pages.length < 4;

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="People and access, security, spend, platform configuration, integrations and what the agents have learned. What is listed depends on your role."
        title={navLabel(ADMIN_HREF)}
      />
      <div className={cn('grid gap-4', !lone && 'sm:grid-cols-2')}>
        {sections.map((section) => (
          <Card className="p-4" key={section.label ?? ''}>
            {section.label && (
              <h2 className="mb-2 text-sm font-semibold text-paper-100">{section.label}</h2>
            )}
            <ul className="space-y-px">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    className={cn(
                      '-mx-2 flex items-start gap-2.5 rounded-md px-2 py-2 text-sm text-paper-300 no-underline transition-colors hover:bg-ink-600 hover:text-paper-100',
                      FOCUS_RING
                    )}
                    href={item.href}
                  >
                    <Icon
                      className="mt-0.5 shrink-0 text-paper-500"
                      name={isIconName(item.icon) ? item.icon : 'dashboard'}
                      size={15}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        {item.label}
                        <Signal
                          hasOrgs={hrefs.has('/admin/organizations')}
                          hasUsers={hrefs.has('/admin/users')}
                          href={item.href}
                        />
                      </span>
                      {PAGE_DESCRIPTIONS[item.href] && (
                        <span className="mt-0.5 block text-xs text-paper-500">
                          {PAGE_DESCRIPTIONS[item.href]}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      {lone && (
        <p className="text-xs text-paper-500">
          {plural(pages.length, 'page')} shown for your role. Platform admins see the rest.
        </p>
      )}
    </div>
  );
}
