import { defineCapabilities } from './define.js';

/**
 * Workflow templates, knowledge, lessons and the knowledge bases attached to repositories. Global
 * (team-less) templates are asked with no resource, which only platform `ADMIN` satisfies.
 */
export const templateCapabilities = defineCapabilities({
  'team.knowledge-bases.manage': {
    class: 'governance',
    description: "Attach, change and detach a repository's knowledge bases.",
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.knowledge.approve': {
    class: 'operation',
    description: 'Approve knowledge for publication at team visibility.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.knowledge.manage': {
    class: 'operation',
    description: "Curate and manage a team's knowledge items.",
    scope: 'team',
    team: 'LEAD',
  },
  'team.lessons.manage': {
    class: 'governance',
    description: "Edit, retire and review a repository's lessons.",
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.templates.generate': {
    class: 'operation',
    description: 'Generate or refine a template from a description.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.templates.review': {
    class: 'operation',
    description: 'Review and approve a change to a team template. The author may not review it.',
    scope: 'team',
    team: 'LEAD',
  },
  'team.templates.shell.author': {
    class: 'sensitive',
    description: 'Put shell, container and gate-command steps in a team template.',
    scope: 'team',
    team: 'ADMIN',
  },
  'team.templates.write': {
    class: 'operation',
    description: "Create, change, publish and retire a team's workflow templates.",
    scope: 'team',
    team: 'LEAD',
  },
});
