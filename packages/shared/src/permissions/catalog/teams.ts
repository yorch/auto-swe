import { defineCapabilities } from './define.js';

/**
 * Team settings, members, budget, secrets, credentials, plugins, agents, skills, callbacks,
 * service principals and sandbox policy. Team creation is `org.teams.create`.
 */
export const teamCapabilities = defineCapabilities({
  'team.agents.manage': {
    class: 'operation',
    description: "Create and change a team's agents and agent versions.",
    scope: 'team',
    team: 'ADMIN',
  },
  'team.agents.read': {
    class: 'read',
    description: 'List the agents a team may use.',
    scope: 'team',
    team: 'MEMBER',
  },
  'team.attention.manage': {
    class: 'operation',
    description: 'Assign unowned failures to a member of the team.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.attention.read': {
    class: 'read',
    description: 'See what is waiting on the team: approvals, failures, budget requests.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.budget-requests.create': {
    class: 'operation',
    description: 'Ask for more budget for a team.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.budget.manage': {
    class: 'governance',
    description: "Set a team's budget cap and decide budget requests.",
    org: 'ADMIN',
    scope: 'team',
    team: 'ADMIN',
  },
  'team.budget.read': {
    class: 'read',
    description: "Read a team's budget and spend.",
    org: 'ADMIN',
    scope: 'team',
    team: 'MEMBER',
  },
  'team.callbacks.manage': {
    class: 'sensitive',
    description: "Create, change, rotate and delete a team's callback endpoints.",
    scope: 'team',
    team: 'LEAD',
  },
  'team.callbacks.read': {
    class: 'read',
    description: "See a team's callback endpoints and their deliveries.",
    scope: 'team',
    team: 'MEMBER',
  },
  'team.credentials.manage': {
    class: 'sensitive',
    description: "Manage a team's model provider credentials.",
    scope: 'team',
    team: 'ADMIN',
  },
  'team.delete': {
    class: 'governance',
    description: 'Delete a team.',
    scope: 'team',
  },
  'team.members.manage': {
    class: 'governance',
    description:
      'Invite, add, change the role of and remove team members, never above the actor’s own rank.',
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.members.read': {
    class: 'read',
    description: "List a team's members.",
    scope: 'team',
    team: 'MEMBER',
  },
  'team.plugins.manage': {
    class: 'operation',
    description: 'Enable and disable plugins for a team.',
    scope: 'team',
    team: 'ADMIN',
  },
  'team.plugins.read': {
    class: 'read',
    description: 'See which plugins a team has enabled.',
    scope: 'team',
    team: 'MEMBER',
  },
  'team.read': {
    class: 'read',
    description: "See a team's detail.",
    scope: 'team',
    team: 'MEMBER',
  },
  'team.sandbox-policy.manage': {
    class: 'sensitive',
    description: "Set a team's shell image allowlist and egress allowlist. Platform admin only.",
    scope: 'team',
  },
  'team.sandbox-policy.read': {
    class: 'read',
    description: "Read a team's shell image allowlist and egress allowlist.",
    scope: 'team',
    team: 'MEMBER',
  },
  'team.secrets.manage': {
    class: 'sensitive',
    description: "Create, rotate and delete a team's secrets.",
    scope: 'team',
    team: 'ADMIN',
  },
  'team.service-principals.manage': {
    class: 'sensitive',
    description: 'Create service principals and mint, rotate and revoke their tokens.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.settings.manage': {
    class: 'governance',
    description: "Change a team's name, description and settings.",
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.skills.assign': {
    class: 'operation',
    description: 'Assign skills to a team’s agents.',
    scope: 'team',
    team: 'ADMIN',
  },
});
