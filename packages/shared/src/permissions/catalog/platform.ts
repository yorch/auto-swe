import { defineCapabilities } from './define.js';

/**
 * Platform-scope capabilities: the instance operator's. Only platform `ADMIN` holds them, except
 * `platform.users.directory.read`, which a lead of any active team also holds (asked with
 * `{ anyTeam: true }`).
 */
export const platformCapabilities = defineCapabilities({
  'platform.agents.runtime.set': {
    class: 'sensitive',
    description: "Change an agent's runtime.",
    scope: 'platform',
  },
  'platform.audit.read': {
    class: 'read',
    description:
      'Read the audit log, security events, activity, assistant diagnostics and platform transcript exports.',
    scope: 'platform',
  },
  'platform.budgets.read-all': {
    class: 'read',
    description: 'Read budget alerts across every organization.',
    scope: 'platform',
  },
  'platform.callbacks.private-network': {
    class: 'sensitive',
    description: 'Let a callback endpoint reach a private network address.',
    scope: 'platform',
  },
  'platform.catalog.manage': {
    class: 'governance',
    description:
      'Manage the model and tool catalogs, global skills and agents, autonomy policies, harness profiles, evals, readiness and outcome reports.',
    scope: 'platform',
  },
  'platform.config.grants.manage': {
    class: 'governance',
    description: 'Create and remove settings grants.',
    scope: 'platform',
  },
  'platform.github.import': {
    class: 'governance',
    description:
      'Import from every repository the instance credential can see, not only those the person reaches.',
    scope: 'platform',
  },
  'platform.integrations.manage': {
    class: 'sensitive',
    description:
      'Configure GitHub credentials, webhook secrets and installations, system config, Slack install, MCP connections, package registries, marketplaces, skill sources and bundles.',
    scope: 'platform',
  },
  'platform.lessons.stats': {
    class: 'read',
    description: 'Read platform-wide lesson statistics.',
    scope: 'platform',
  },
  'platform.orgs.trust-invites.manage': {
    class: 'governance',
    description: 'Decide which email domains an organization trusts for invitations.',
    scope: 'platform',
  },
  'platform.pr-evaluation.auto-mode': {
    class: 'sensitive',
    description: "Set a repository's pull-request evaluation to auto mode, or enable bot approval.",
    scope: 'platform',
  },
  'platform.repo-dependencies.scan': {
    class: 'operation',
    description: 'Start a repository dependency scan.',
    scope: 'platform',
  },
  'platform.reports.read-all': {
    class: 'read',
    description:
      'Read platform-wide usage and delivery reports, with approver identities unmasked.',
    scope: 'platform',
  },
  'platform.repos.eval-dataset.link-org': {
    class: 'sensitive',
    description: 'Link an organization-scope eval dataset to a repository.',
    scope: 'platform',
  },
  'platform.repos.executor-image.probe': {
    class: 'sensitive',
    description: "Probe a repository's executor image.",
    scope: 'platform',
  },
  'platform.repos.installation.bind': {
    class: 'sensitive',
    description:
      'Link an unverified GitHub installation to a repository, set the executor image build, and change a repository tool allowlist.',
    scope: 'platform',
  },
  'platform.scanner.manage': {
    class: 'sensitive',
    description: 'Create, change and remove runtime scanner patterns.',
    scope: 'platform',
  },
  'platform.sessions.manage': {
    class: 'governance',
    description: 'List and revoke access tokens and sessions.',
    scope: 'platform',
  },
  'platform.shell-audit.prune': {
    class: 'sensitive',
    description: 'Prune the shell audit trail.',
    scope: 'platform',
  },
  'platform.slack-channels.manage': {
    class: 'governance',
    description: 'Create and change Slack channels, erase a user, edit channel memory.',
    scope: 'platform',
  },
  'platform.transcripts.retention.manage': {
    class: 'sensitive',
    description:
      'Place and lift legal holds on runs and transcripts, and verify transcript integrity.',
    scope: 'platform',
  },
  'platform.users.directory.read': {
    class: 'read',
    description: 'Look people up in the user directory. Held by a lead of any active team.',
    requiresActiveTeam: true,
    scope: 'platform',
    team: 'LEAD',
  },
  'platform.users.manage': {
    class: 'governance',
    description: 'Create users, change their platform role, activate or deactivate them.',
    scope: 'platform',
  },
});
