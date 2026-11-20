import { navLabel } from '@/lib/navigation';

/**
 * The product tour: an ordered list of short steps, each pointing at one element of the shell.
 *
 * A step's `anchor` is the value of a `data-tour` attribute: `nav:<href>` for a sidebar link
 * (the exact `href` from `lib/navigation.ts`) or `sidebar` for the sidebar itself. A null anchor is a step about no one element, shown centered. The tour card falls
 * back to the centered position too when the anchor is missing or hidden, so a step never points
 * at nothing. `tourSteps.test.tsx` renders the real sidebar and checks every anchor exists.
 *
 * `adminOnly` marks a step for platform admins. It must agree with the `access` of the navigation
 * entry the anchor names (the test checks), so a page the sidebar hides from someone is never
 * described to them. Every sentence below restates what the page itself says it does.
 */
export interface TourStep {
  id: string;
  anchor: string | null;
  title: string;
  body: string;
  /** Replaces `body` for someone who leads a team, where the page offers more than to a member. */
  leadBody?: string;
  /** Replaces `body` and `leadBody` for a platform admin, where the page offers more again. */
  adminBody?: string;
  /** Only a platform admin sees the step. */
  adminOnly?: true;
}

/**
 * A step of a per-page tour: the part of a step the tour card needs. A page registers these
 * through `PageTour`; its anchors are `data-tour` attributes the page itself renders, and the
 * page's own test checks each one exists.
 */
export type PageTourStep = Pick<TourStep, 'id' | 'anchor' | 'title' | 'body'>;

export const TOUR_STEPS: TourStep[] = [
  {
    anchor: 'sidebar',
    body: 'The sidebar lists the pages you can open, grouped into Work, Teams, Build, Connect, Knowledge and Admin. Collapse it to an icon rail when you need more room. What appears depends on what you may do.',
    id: 'sidebar',
    title: 'Main navigation',
  },
  {
    anchor: 'nav:/start',
    body: 'Start a workflow, or run a single agent on one repository.',
    id: 'start-work',
    leadBody:
      'Start a workflow, run a single agent on one repository, or run a multi-repo epic from one brief.',
    title: 'Start work',
  },
  {
    anchor: 'nav:/approvals',
    body: 'Runs that stop at a gate wait here for a person to approve, decide, fill in a form or review. The sidebar badge shows how many are waiting on you.',
    id: 'approvals',
    title: navLabel('/approvals'),
  },
  {
    anchor: 'nav:/requests',
    body: 'Every request you made, with retries kept together. “Needs attention” means a person is needed or a run failed or timed out.',
    id: 'requests',
    title: navLabel('/requests'),
  },
  {
    anchor: 'nav:/pull-requests',
    body: 'Pull requests the platform opened, with their state on the host, CI and the run behind them. No built-in step or template merges a pull request; you review and merge it on the host, unless its repository is in auto mode, where GitHub may merge a qualifying low-risk one.',
    id: 'pull-requests',
    title: navLabel('/pull-requests'),
  },
  {
    anchor: 'nav:/library',
    body: 'Your reusable workflow templates. Pick one, run it with your inputs, and follow the request.',
    id: 'workflow-library',
    title: navLabel('/library'),
  },
  {
    adminOnly: true,
    anchor: 'nav:/agents',
    body: 'Versioned agents. Saving an edit creates a new version; runs already in progress keep the version they started with.',
    id: 'agents',
    title: navLabel('/agents'),
  },
  {
    adminBody:
      'Administration in one place, with its own menu: users and teams, platform settings, autonomy policies, integration credentials, security events and more.',
    anchor: 'nav:/admin',
    body: 'Teams, analytics, automations and knowledge, in one area with its own menu.',
    id: 'admin',
    leadBody:
      'Teams and organizations, platform settings, analytics, automations and knowledge, in one area with its own menu. Platform settings is operator policy; each row says which scope its value comes from.',
    title: navLabel('/admin'),
  },
  {
    anchor: 'sidebar:user-menu',
    body: 'Open your user menu for Docs: how auto-swe works and how to run it, with concepts, setup guides and references. Settings lives here too.',
    id: 'docs',
    title: navLabel('/docs'),
  },
  {
    anchor: null,
    body: 'A small ? button beside a term opens a short explanation, often with a link to the docs. Hover it, focus it or click it.',
    id: 'help-tips',
    title: 'Help on the page',
  },
];

/** What decides which steps and wordings a person sees, as the server's permissions say it. */
export interface TourAudience {
  /** Holds every capability: sees the administration steps and wording. */
  platformAdmin: boolean;
  /** May start work across repositories on some team (a team lead): sees the lead wording. */
  teamLead: boolean;
}

/** The steps `audience` sees, in order. Someone with neither flag sees the member steps. */
export function buildTourSteps(audience: TourAudience): TourStep[] {
  return TOUR_STEPS.filter((step) => !step.adminOnly || audience.platformAdmin).map((step) => {
    if (step.adminBody && audience.platformAdmin) {
      return { ...step, body: step.adminBody };
    }
    return step.leadBody && (audience.platformAdmin || audience.teamLead)
      ? { ...step, body: step.leadBody }
      : step;
  });
}
