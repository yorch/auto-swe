/** Titles and one-line explanations for each setting group on the platform settings page. */
export const GROUP_TITLES: Record<string, string> = {
  channel: 'Channel assistant',
  github: 'GitHub access',
  mcp: 'MCP server',
  memory: 'Semantic memory',
  repoAccess: 'Repository access',
  repoDependency: 'Repo dependency graph',
  skills: 'Skill imports',
  workflow: 'Workflow interpreter',
  workspace: 'Agent workspace',
};

export const GROUP_BLURBS: Record<string, string> = {
  channel:
    'How proactive the Slack assistant is and how much context it reads per turn. Overridable per channel, so one noisy channel can be tuned without touching the rest.',
  github:
    'Which GitHub hosts repositories may use, and whether people can run work with their own GitHub token.',
  mcp: 'Whether the platform acts as an MCP server for outside clients, and how much they may do.',
  memory: 'Relevance thresholds for what semantic memory surfaces.',
  repoAccess: 'Who can reach a repository, and how stale a shared view may get.',
  repoDependency:
    'How confidently an LLM-inferred repo-to-repo dependency edge must be evidenced before it is promoted straight to active instead of waiting for a human confirm.',
  skills: 'How skills imported from external repositories are screened and fetched.',
  workflow:
    'Bounds on how far one run may expand. Frozen when a run starts, so changing them affects new runs only.',
  workspace:
    'Container images and isolation for agent workspaces, plus worker capacity. Mostly platform-wide.',
};
