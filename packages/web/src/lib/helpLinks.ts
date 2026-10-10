/**
 * Every inline documentation link a page or component renders, by purpose.
 * `lib/helpLinks.test.ts` checks each entry against the files and headings under `docs/`, so a
 * renamed heading fails a test rather than breaking a link silently. The glossary keeps its own
 * registry (`lib/glossary.ts`) with the same check.
 */
export const HELP_LINKS = {
  agentLibrary: { anchor: '1-agents', slug: 'agents' },
  agentToolAccess: { anchor: '7-tool-access-control-agenttoolkeys', slug: 'agents' },
  approvals: { slug: 'hitl-workflows' },
  architectureNodeTypes: { anchor: 'node-types', slug: 'architecture' },
  automations: { slug: 'automations' },
  autonomyPolicies: { slug: 'autonomy-policies' },
  autonomyPolicyDecisionLog: { anchor: '5-the-decision-log', slug: 'autonomy-policies' },
  bundles: { slug: 'bundles' },
  canaryRouting: { anchor: '4-scheduling-and-canary', slug: 'evals' },
  concepts: { slug: 'concepts' },
  conceptsLessons: { anchor: 'agents', slug: 'concepts' },
  conceptsWorkflows: { anchor: 'workflows', slug: 'concepts' },
  configGrants: { anchor: '3-who-may-change-what', slug: 'configuration' },
  configuration: { slug: 'configuration' },
  evals: { slug: 'evals' },
  githubAppSetup: { slug: 'github-app-setup' },
  mcpServer: { slug: 'mcp-server' },
  modelConfiguration: { slug: 'model-configuration' },
  platformSettingsCascade: { anchor: '2-resolution-order', slug: 'configuration' },
  scannerWriteToolChain: { anchor: '34-write-tool-security-chain', slug: 'agents' },
  skills: { anchor: '6-skills', slug: 'agents' },
} as const satisfies Record<string, { slug: string; anchor?: string }>;
