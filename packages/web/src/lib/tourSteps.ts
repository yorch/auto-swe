import type { Role } from '@auto-swe/shared';
import { navLabel } from '@/lib/navigation';
import { hasRole } from '@/lib/roles';

/**
 * The product tour: an ordered list of short steps, each pointing at one element of the shell.
 *
 * A step's `anchor` is the value of a `data-tour` attribute: `nav:<href>` for a sidebar link
 * (the exact `href` from `lib/navigation.ts`) or `sidebar` for the sidebar itself. A null anchor is a step about no one element, shown centered. The tour card falls
 * back to the centered position too when the anchor is missing or hidden, so a step never points
 * at nothing. `tourSteps.test.tsx` renders the real sidebar and checks every anchor exists.
 *
 * `roles` lists the platform roles that see the step. It must agree with `minRole` of the
 * navigation entry the anchor names (the test checks), so a page the sidebar hides from a role is
 * never described to it. Every sentence below restates what the page itself says it does.
 */
export interface TourStep {
  id: string;
  anchor: string | null;
  title: string;
  body: string;
  /** Replaces `body` for LEAD and ADMIN, where the page offers more than it does to an engineer. */
  leadBody?: string;
  roles: Role[];
}

const ALL: Role[] = ['ENGINEER', 'LEAD', 'ADMIN'];
const LEAD_UP: Role[] = ['LEAD', 'ADMIN'];
const ADMIN_ONLY: Role[] = ['ADMIN'];

export const TOUR_STEPS: TourStep[] = [
  {
    anchor: 'sidebar',
    body: 'The sidebar lists the pages you can open, grouped into sections such as Work and Govern. What appears depends on your role.',
    id: 'sidebar',
    roles: ALL,
    title: 'Main navigation',
  },
  {
    anchor: 'nav:/start',
    body: 'Start a workflow, or run a single agent on one repository.',
    id: 'start-work',
    leadBody:
      'Start a workflow, run a single agent on one repository, or run a multi-repo epic from one brief.',
    roles: ALL,
    title: 'Start work',
  },
  {
    anchor: 'nav:/workflows',
    body: 'Every request you made, with retries kept together. “Needs attention” means a person is needed or a run failed or timed out.',
    id: 'requests',
    roles: ALL,
    title: navLabel('/workflows'),
  },
  {
    anchor: 'nav:/pull-requests',
    body: 'Pull requests the platform opened, with their state on the host, CI and the run behind them. No built-in step or template merges a pull request; you review and merge it on the host.',
    id: 'pull-requests',
    roles: ALL,
    title: navLabel('/pull-requests'),
  },
  {
    anchor: 'nav:/govern/approvals',
    body: 'Runs that stop at a gate wait here for a person to approve, decide, fill in a form or review. The sidebar badge shows how many are waiting on you.',
    id: 'approvals',
    roles: ALL,
    title: navLabel('/govern/approvals'),
  },
  {
    anchor: 'nav:/docs',
    body: 'How auto-swe works and how to run it: concepts, setup guides and references.',
    id: 'docs',
    roles: ALL,
    title: navLabel('/docs'),
  },
  {
    anchor: null,
    body: 'A small ? button beside a term opens a short explanation, often with a link to the docs. Hover it, focus it or click it.',
    id: 'help-tips',
    roles: ALL,
    title: 'Help on the page',
  },
  {
    anchor: 'nav:/govern/platform-settings',
    body: 'Operator policy for agents, channels and workflows. Each row says which scope its value comes from.',
    id: 'platform-settings',
    roles: LEAD_UP,
    title: navLabel('/govern/platform-settings'),
  },
  {
    anchor: 'nav:/studio/agents/library',
    body: 'Versioned agents. Saving an edit creates a new version; runs already in progress keep the version they started with.',
    id: 'agents',
    roles: ADMIN_ONLY,
    title: navLabel('/studio/agents/library'),
  },
  {
    anchor: 'nav:/studio/integrations',
    body: 'Credentials for GitHub, Slack, your issue tracker, knowledge base and Figma.',
    id: 'integrations',
    roles: ADMIN_ONLY,
    title: navLabel('/studio/integrations'),
  },
  {
    anchor: 'nav:/govern/policies',
    body: 'Which risk classes an agent may act on automatically and which need human approval, globally, per team or per workflow template.',
    id: 'autonomy-policies',
    roles: ADMIN_ONLY,
    title: navLabel('/govern/policies'),
  },
];

/** The steps `role` sees, in order. An unknown or missing role sees the engineer steps. */
export function buildTourSteps(role: string | null | undefined): TourStep[] {
  const effective: Role = hasRole(role, 'ADMIN')
    ? 'ADMIN'
    : hasRole(role, 'LEAD')
      ? 'LEAD'
      : 'ENGINEER';
  return TOUR_STEPS.filter((step) => step.roles.includes(effective)).map((step) =>
    step.leadBody && effective !== 'ENGINEER' ? { ...step, body: step.leadBody } : step
  );
}
