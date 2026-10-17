'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useHasRole } from '@/hooks/useHasRole';
import { useReadiness } from '@/hooks/useReadiness';
import { focusMainContent, useDismissed } from '@/lib/dismissed';
import { cn, FOCUS_RING } from '@/lib/utils';

export const GOVERNANCE_DISMISS_KEY = 'governance-guide';

interface GuideLink {
  label: string;
  href: string;
  reason: string;
}

interface GuideGroup {
  title: string;
  links: GuideLink[];
}

/** The order an admin is best served reading the Admin pages in. Hrefs are checked against the nav. */
export const GOVERNANCE_GROUPS: GuideGroup[] = [
  {
    links: [
      {
        href: '/admin/users',
        label: 'Users',
        reason:
          'New sign-ups can wait here for your approval. A GitHub sign-in from an organization on the auto-approve list is approved automatically.',
      },
      {
        href: '/admin/teams',
        label: 'Teams',
        reason: 'Teams own repositories, members, sandbox allowlists and per-team agent overrides.',
      },
    ],
    title: 'Who and what',
  },
  {
    links: [
      {
        href: '/admin/policies',
        label: 'Autonomy policies',
        reason:
          'Choose which risk classes an agent may act on automatically and which need human approval.',
      },
      {
        href: '/approvals',
        label: 'Approvals',
        reason: 'Runs that stopped at a gate wait here for a person to answer.',
      },
    ],
    title: 'Control the agents',
  },
  {
    links: [
      {
        href: '/admin/scanner',
        label: 'Scanner patterns',
        reason:
          'The patterns behind the runtime scanners that block or flag risky shell commands, file writes and skill text.',
      },
      {
        href: '/admin/security',
        label: 'Security events',
        reason: 'What the scanners stopped or flagged across all runs, newest first.',
      },
    ],
    title: 'Guardrails',
  },
  {
    links: [
      {
        href: '/admin/platform-settings',
        label: 'Platform settings',
        reason: 'Operator policy settings; each is badged when its value is frozen per run.',
      },
      {
        href: '/admin/workflow-defaults',
        label: 'Workflow defaults',
        reason: 'Branch prefix, pull request templates, budget tiers and the CI wait strategy.',
      },
    ],
    title: 'Configuration',
  },
  {
    links: [
      {
        href: '/admin/usage',
        label: 'LLM usage',
        reason:
          'Every LLM and embedding call, attributed to the team and organization whose spend it is.',
      },
      {
        href: '/admin/analytics',
        label: 'Analytics',
        reason: 'Run volume, outcomes, cost and time saved across workflow templates.',
      },
    ],
    title: 'Cost and ROI',
  },
  {
    links: [
      {
        href: '/admin/automations',
        label: 'Automations',
        reason:
          'Everything that starts a run without a person pressing run: event rules, schedules and webhooks.',
      },
      {
        href: '/lessons',
        label: 'Lessons',
        reason: 'Lessons agents captured from completed workflows, and their consolidation.',
      },
      {
        href: '/admin/evals',
        label: 'Evals',
        reason: 'Quality signals over time and the datasets offline runs score against.',
      },
    ],
    title: 'Automation and quality',
  },
];

/**
 * Admin Home guide to the Admin pages, shown once the setup card has nothing left to fix. It is
 * a reading order, not a progress tracker: nothing here can be marked done, because the platform
 * cannot tell whether a policy has been reviewed.
 */
export function GovernanceGuide() {
  const isAdmin = useHasRole('ADMIN');
  const { ready, dismissed, dismiss } = useDismissed(GOVERNANCE_DISMISS_KEY);
  const readiness = useReadiness(isAdmin);
  if (!isAdmin || !ready || dismissed || readiness.data?.ready !== true) {
    return null;
  }
  return (
    <Card data-testid="governance-guide">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-paper-50">Set up governance</h2>
          <p className="mt-1 text-sm text-paper-400">
            A suggested order for reading the Admin pages. It is a guide, not a checklist: nothing
            here tracks what you have reviewed.
          </p>
        </div>
        <Button
          aria-label="Dismiss the governance guide"
          onClick={() => {
            dismiss();
            focusMainContent();
          }}
          size="sm"
          variant="ghost"
        >
          Dismiss
        </Button>
      </div>
      <ol className="mt-5 grid gap-4 lg:grid-cols-2">
        {GOVERNANCE_GROUPS.map((group, index) => (
          <li className="rounded-lg border border-ink-500/60 p-4" key={group.title}>
            <h3 className="text-sm font-medium text-paper-100">
              <span className="tabular mr-2 text-paper-500">{index + 1}</span>
              {group.title}
            </h3>
            <ul className="mt-2 space-y-2">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    className={cn(
                      'inline-flex items-center gap-1 rounded-sm text-sm font-medium text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
                      FOCUS_RING
                    )}
                    href={link.href}
                  >
                    {link.label}
                    <Icon name="arrowRight" size={12} />
                  </Link>
                  <p className="text-xs text-paper-400">{link.reason}</p>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Card>
  );
}
