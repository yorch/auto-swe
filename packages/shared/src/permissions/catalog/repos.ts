import { defineCapabilities } from './define.js';

/**
 * Repository capabilities, asked of the repository's owning team. A team a repository is shared
 * with confers none of them; reach (team membership, shares, the GitHub gate) is a separate gate.
 */
export const repoCapabilities = defineCapabilities({
  'team.repos.create': {
    class: 'governance',
    description: 'Create a repository under a team.',
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.repos.deps.manage': {
    class: 'governance',
    description:
      'Create, delete and veto dependency edges between repositories. A new edge needs it on both teams, a deletion on either.',
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.repos.eval-link': {
    class: 'sensitive',
    description: 'Link a team-scope eval dataset to a repository.',
    scope: 'team',
    team: 'ADMIN',
  },
  'team.repos.gate-commands.author': {
    class: 'sensitive',
    description: "Write a repository's gate commands, which run as code in the workspace.",
    scope: 'team',
    team: 'ADMIN',
  },
  'team.repos.manage': {
    class: 'governance',
    description:
      'Edit, share, deactivate and test access to a repository, and change its pull-request evaluation settings.',
    org: 'ADMIN',
    scope: 'team',
    team: 'LEAD',
  },
  'team.repos.onboarding.launch': {
    class: 'sensitive',
    description:
      'Start a repository onboarding run, which proposes gate commands and previews that run as code. Other onboarding routes need team.repos.manage.',
    scope: 'team',
    team: 'ADMIN',
  },
});
