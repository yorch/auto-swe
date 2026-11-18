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
  'team.approvals.nudge': {
    class: 'operation',
    description: 'Nudge an overdue approval step.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.launch': {
    class: 'operation',
    description: 'Start a run for a team, or as a team lead where a template requires one.',
    scope: 'team',
    team: 'MEMBER',
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
