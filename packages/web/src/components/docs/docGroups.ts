/**
 * How the docs index groups the top-level docs for a reader choosing where to start. The
 * grouping is by audience, not by directory: a slug not listed here lands in `Reference`, so a
 * new doc still appears in the index without a change to this file.
 */
const GROUPS = [
  {
    id: 'getting-started',
    slugs: ['quickstart', 'product-overview', 'concepts', 'architecture'],
    title: 'Getting started',
  },
  {
    id: 'using',
    slugs: [
      'repositories',
      'agents',
      'agent-runs',
      'workflow-nodes',
      'workflow-inventory',
      'hitl-workflows',
      'work-views',
      'run-activity',
      'channel-assistant',
      'nl-workflow-authoring',
      'automations',
      'ci-failure-triggers',
      'pr-feedback',
      'pr-evaluation',
      'maintenance-workflows',
      'repo-dependency-graph',
      'ui-validation',
      'transcripts',
      'memory',
      'knowledge',
      'evals',
      'reporting',
      'user-activity',
      'user-github-credentials',
      'figma-integration',
      'local-agents',
      'mcp-server',
      'bundles',
    ],
    title: 'Using the platform',
  },
  {
    id: 'administration',
    slugs: [
      'deployment',
      'configuration',
      'model-configuration',
      'github-app-setup',
      'slack-app-setup',
      'oauth-setup',
      'repo-access-gating',
      'autonomy-policies',
      'service-principals',
      'package-registries',
      'inbound-events',
      'run-callbacks',
      'audit-log',
      'upgrade-notes',
    ],
    title: 'Administration',
  },
] as const;

const REFERENCE = { id: 'reference', title: 'Reference' } as const;

const GROUP_OF = new Map<string, string>(
  GROUPS.flatMap((group) => group.slugs.map((slug) => [slug, group.id] as const))
);

export interface DocGroup<T> {
  id: string;
  title: string;
  docs: T[];
}

/** The docs in reading order by group, with empty groups dropped. Input order is kept within a group. */
export function groupDocs<T extends { slug: string }>(docs: readonly T[]): DocGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const doc of docs) {
    const id = GROUP_OF.get(doc.slug) ?? REFERENCE.id;
    buckets.set(id, [...(buckets.get(id) ?? []), doc]);
  }
  const ordered = [...GROUPS, REFERENCE];
  return ordered
    .map((group) => ({ docs: buckets.get(group.id) ?? [], id: group.id, title: group.title }))
    .filter((group) => group.docs.length > 0);
}
