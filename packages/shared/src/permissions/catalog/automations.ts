import { defineCapabilities } from './define.js';

/**
 * What starts or reports on work without a person at the keyboard: schedules, automations, event
 * endpoints, digests, usage, Slack channels and code review.
 */
export const automationCapabilities = defineCapabilities({
  'team.automations.manage': {
    class: 'operation',
    description: 'Create, change and delete event automations.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.automations.read': {
    class: 'read',
    description: "See a team's automations and their decision ledger.",
    scope: 'team',
    team: 'MEMBER',
  },
  'team.codereview.manage': {
    class: 'operation',
    description: "Create and change a team's code review presets and attachments.",
    scope: 'team',
    team: 'LEAD',
  },
  'team.codereview.read': {
    class: 'read',
    description: "See a team's code review presets and attachments.",
    scope: 'team',
    team: 'MEMBER',
  },
  'team.digests.manage': {
    class: 'governance',
    description: 'Manage report digests delivered at team scope.',
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.event-endpoints.manage': {
    class: 'sensitive',
    description:
      "Create, rotate and delete a team's inbound event endpoints and their signing secrets.",
    scope: 'team',
    team: 'LEAD',
  },
  'team.schedules.create': {
    class: 'operation',
    description:
      'Create a schedule on a repository. Asked on the owning team and on each team the repository is shared with.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.schedules.manage': {
    class: 'operation',
    description:
      'Change, pause and delete a schedule. Asked on the repository’s owning team and on the schedule’s own team.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.slack-channels.read': {
    class: 'read',
    description: "See a team's Slack channels. A private channel also needs Slack membership.",
    scope: 'team',
    team: 'MEMBER',
  },
  'team.usage.read': {
    class: 'read',
    description: "Read a team's usage report.",
    scope: 'team',
    team: 'LEAD',
  },
});
