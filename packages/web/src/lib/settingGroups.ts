/** Titles and one-line explanations for each setting group on the platform settings page. */
export const GROUP_TITLES: Record<string, string> = {
  analytics: 'Product analytics',
  assistant: 'In-app assistant',
  audit: 'Audit log',
  channel: 'Channel assistant',
  evals: 'Eval benchmark',
  git: 'Git commit identity',
  github: 'GitHub access',
  mcp: 'MCP server',
  memory: 'Semantic memory',
  models: 'Model providers',
  prEvaluation: 'Pull request evaluation',
  qodo: 'Qodo review',
  repoAccess: 'Repository access',
  repoDependency: 'Repo dependency graph',
  skills: 'Skill imports',
  workflow: 'Workflow interpreter',
  workspace: 'Agent workspace',
};

export const GROUP_BLURBS: Record<string, string> = {
  analytics:
    'First-party activity events: whether the dashboard reports page views, and how long recorded events are kept.',
  assistant: 'Whether the dashboard assistant may act on behalf of the person using it.',
  audit: 'How long the administrative audit log is kept. The default keeps it forever.',
  channel:
    'How proactive the Slack assistant is and how much context it reads per turn. Overridable per channel, so one noisy channel can be tuned without touching the rest.',
  evals:
    'How thoroughly a benchmark case is checked for a flaky reference before the regression harness scores it.',
  git: 'Who the platform commits as, and whether the person who launched a run is credited. Overridable per team, organization and workflow template.',
  github:
    'Which GitHub hosts repositories may use, and whether people can run work with their own GitHub token.',
  mcp: 'Whether the platform acts as an MCP server for outside clients, and how much they may do.',
  memory: 'Relevance thresholds for what semantic memory surfaces.',
  models:
    'Which internal hosts a provider credential may point at, for LLM endpoints on a private network.',
  prEvaluation:
    'Risk class, approver counts and the auto-merge gate for the pull requests the platform opens.',
  qodo: "Whether the platform may read Qodo's review of pull requests through a team's Qodo connection.",
  repoAccess: 'Who can reach a repository, and how stale a shared view may get.',
  repoDependency:
    'How confidently an LLM-inferred repo-to-repo dependency edge must be evidenced before it is promoted straight to active instead of waiting for a human confirm.',
  skills: 'How skills imported from external repositories are screened and fetched.',
  workflow:
    'Bounds on how far one run may expand. Frozen when a run starts, so changing them affects new runs only.',
  workspace:
    'Container images and isolation for agent workspaces, plus worker capacity. Mostly platform-wide.',
};
