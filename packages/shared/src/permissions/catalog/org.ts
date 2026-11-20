import { defineCapabilities } from './define.js';

/**
 * Organization-scope capabilities, classed by who they are for: an organization `ADMIN` holds the
 * organization's own governance, including its GitHub App link and its budget.
 */
export const orgCapabilities = defineCapabilities({
  'org.baselines.manage': {
    class: 'governance',
    description: "Create and remove the organization's human-error baselines.",
    org: 'ADMIN',
    scope: 'org',
  },
  'org.baselines.read': {
    class: 'read',
    description: "Read the organization's human-error baselines.",
    org: 'MEMBER',
    scope: 'org',
  },
  'org.budget.manage': {
    class: 'governance',
    description: "Read the organization's spend in dollars and set its budget cap.",
    org: 'ADMIN',
    scope: 'org',
  },
  'org.digests.manage': {
    class: 'governance',
    description: 'Manage report digests delivered at organization scope.',
    org: 'ADMIN',
    scope: 'org',
  },
  'org.github.manage': {
    class: 'governance',
    description: "Link, change and unlink the organization's GitHub App.",
    org: 'ADMIN',
    scope: 'org',
  },
  'org.knowledge.publish': {
    class: 'governance',
    description: 'Publish knowledge at organization visibility and approve knowledge that has it.',
    org: 'ADMIN',
    scope: 'org',
  },
  'org.members.manage': {
    class: 'governance',
    description:
      'Add, invite, change the role of and remove organization members, including the team role an invitation carries.',
    org: 'ADMIN',
    scope: 'org',
  },
  'org.members.read': {
    class: 'read',
    description: "List the organization's members.",
    org: 'MEMBER',
    scope: 'org',
  },
  'org.read': {
    class: 'read',
    description: 'See the organization, its detail and its budget alert level.',
    org: 'MEMBER',
    scope: 'org',
  },
  'org.reports.read': {
    class: 'read',
    description: "Read the organization's usage and delivery reports.",
    org: 'ADMIN',
    scope: 'org',
  },
  'org.settings.manage': {
    class: 'governance',
    description: "Change the organization's name and slug.",
    org: 'ADMIN',
    scope: 'org',
  },
  'org.teams.create': {
    class: 'governance',
    description:
      'Create a team in the organization. Both team-creation routes check it; only the organization route also admits a member where self-service creation is on.',
    org: 'ADMIN',
    scope: 'org',
  },
});
