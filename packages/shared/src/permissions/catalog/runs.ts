import { defineCapabilities } from './define.js';

/**
 * Starting and steering work. Reach (which repositories a person may launch on, a share's
 * `canLaunch`, the GitHub gate) and run visibility are separate gates and are not here; the
 * capabilities below answer only "may this team role do this for the team".
 */
export const runCapabilities = defineCapabilities({
  'team.approvals.answer': {
    class: 'operation',
    description: 'Answer an approval, decision or input step of a team’s run.',
    scope: 'team',
    team: 'MEMBER',
  },
  'team.approvals.merge': {
    class: 'operation',
    description:
      'Approve the merge gate of a team’s run from Slack. Asked on the run’s owning teams; any one suffices.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.approvals.nudge': {
    class: 'operation',
    description: 'Nudge an overdue approval step.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.launch': {
    class: 'operation',
    description: 'Start a run for a team.',
    scope: 'team',
    team: 'MEMBER',
  },
  'team.launch.as-lead': {
    class: 'operation',
    description:
      'Start a run attributed to a team the caller leads, as a schedule’s fire does for its own team.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.launch.multi-repo': {
    class: 'operation',
    description:
      'Start a campaign, epic or PRD run across repositories. Asked on every repository’s owning team.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.orchestrations.stop': {
    class: 'operation',
    description:
      'Emergency-stop an orchestration that a service principal launched. Platform admin only.',
    scope: 'team',
  },
  'team.runs.control': {
    class: 'operation',
    description: 'Cancel or retry a team’s run.',
    scope: 'team',
    team: 'MEMBER',
  },
});
