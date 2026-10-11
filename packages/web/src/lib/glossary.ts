/**
 * The product vocabulary, written for someone who has never seen auto-swe.
 * `docs/concepts.md` is the long form; every definition here agrees with it.
 * `doc` points at a top-level doc the in-app reader serves, and `anchor` at a
 * heading id the reader generates for it (`glossary.test.ts` checks both).
 */
export interface GlossaryEntry {
  label: string;
  definition: string;
  doc?: { slug: string; anchor?: string };
}

export const GLOSSARY = {
  agent: {
    definition:
      'A versioned, named configuration of a model, a system prompt, a set of skills, and the tools it may use. Agents are data, so a new one needs no deploy.',
    doc: { anchor: '1-agents', slug: 'agents' },
    label: 'Agent',
  },
  agentRun: {
    definition:
      'One agent, one prompt, and one repository, launched on demand instead of through a workflow you author. It can optionally publish its work as a branch or a draft pull request.',
    doc: { slug: 'agent-runs' },
    label: 'Agent run',
  },
  approval: {
    definition:
      'A person’s yes or no on a gate. Pending approvals wait in the approvals inbox, and the run resumes as soon as someone answers.',
    doc: { anchor: 'the-inbox-ui', slug: 'hitl-workflows' },
    label: 'Approval',
  },
  autonomyPolicy: {
    definition:
      'The rule that decides whether an action, such as posting a public reply or filing an issue, may happen without a person. It is set per risk class, team, and template, and it fails closed.',
    doc: { anchor: '1-what-a-policy-decides', slug: 'autonomy-policies' },
    label: 'Autonomy policy',
  },
  budgetTier: {
    definition:
      'The token ceiling a run is held to: STANDARD, LARGE, or EPIC. A run that exceeds it is stopped.',
    doc: { anchor: 'running-work', slug: 'concepts' },
    label: 'Budget tier',
  },
  bundle: {
    definition:
      'A signed package of agents, skills, scanner patterns, and templates for moving them between deployments.',
    doc: { anchor: 'what-a-bundle-carries', slug: 'bundles' },
    label: 'Bundle',
  },
  canary: {
    definition:
      'A candidate agent version served to a deterministic share of runs, so its scores can be compared directly with the current version before it replaces it.',
    doc: { anchor: '4-scheduling-and-canary', slug: 'evals' },
    label: 'Canary',
  },
  connection: {
    definition:
      'A configured link to an outside system, such as a git repository, an issue tracker, Notion, Zendesk, Slack, or an MCP server. Templates name the kind of connection they need.',
    doc: { anchor: 'configuration', slug: 'concepts' },
    label: 'Connection',
  },
  epic: {
    definition:
      'A brief that spans several repositories. A planner agent splits it into one run per repository and starts them in dependency order.',
    doc: { slug: 'repo-dependency-graph' },
    label: 'Epic',
  },
  eval: {
    definition:
      'A measurement of output quality, either scored inside a run or offline against a frozen dataset to catch regressions.',
    doc: { anchor: '1-the-three-mechanisms', slug: 'evals' },
    label: 'Eval',
  },
  gate: {
    definition:
      'A place where a run stops until a person acts. The run waits for an answer in the approvals inbox or in Slack, or for a timeout to route it elsewhere.',
    doc: { anchor: 'what-a-hitl-node-does', slug: 'hitl-workflows' },
    label: 'Gate',
  },
  lesson: {
    definition:
      'What a finished run learned, stored so later runs on the same repository can retrieve it as context.',
    doc: { anchor: '1-storage', slug: 'memory' },
    label: 'Lesson',
  },
  node: {
    definition:
      'One step of a workflow template: an agent call, a branch, a wait for an outside event, a sandboxed command, a score, or a stop for a person.',
    doc: { anchor: 'node-types', slug: 'architecture' },
    label: 'Node',
  },
  request: {
    definition:
      'A request to do something: a ticket to implement, a PRD to break down, a support ticket to answer. It names a workflow template and carries the inputs that template asks for.',
    doc: { anchor: 'running-work', slug: 'concepts' },
    label: 'Request',
  },
  riskClass: {
    definition:
      'A label for the kind of thing a run is about to do, such as an internal write or an external communication. An autonomy policy looks up what each class requires; a class with no rule requires approval.',
    doc: { anchor: '1-what-a-policy-decides', slug: 'autonomy-policies' },
    label: 'Risk class',
  },
  run: {
    definition:
      'One execution of one workflow template version. It survives restarts, can wait days for a person or for CI, and records every step, agent transcript, and token it spent.',
    doc: { anchor: 'running-work', slug: 'concepts' },
    label: 'Run',
  },
  scannerPattern: {
    definition:
      'A rule that matches risky text, such as an unsafe shell command or a sensitive file path. Scanners check what agents write and run, and administrators can add their own patterns.',
    doc: { anchor: '34-write-tool-security-chain', slug: 'agents' },
    label: 'Scanner pattern',
  },
  scopeCascade: {
    definition:
      'How a setting resolves when several levels set it, most specific first: workflow template, channel, team, organization, global. It lets one platform behave differently per team.',
    doc: { anchor: '2-resolution-order', slug: 'configuration' },
    label: 'Scope cascade',
  },
  skill: {
    definition:
      'A named fragment of instructions added to an agent’s prompt. It shapes how the agent reasons, not what it is allowed to do.',
    doc: { anchor: '6-skills', slug: 'agents' },
    label: 'Skill',
  },
  ticket: {
    definition:
      'The label work is filed under: usually your tracker’s issue key, such as JIRA-1234, or a generated id when none was given. It is free text that auto-swe does not check against a tracker, not an auto-swe object.',
    label: 'Ticket',
  },
  tool: {
    definition:
      'Something an agent can execute, such as reading or writing a file, running a shell command, or calling an MCP server. Which tools an agent may use is part of its configuration.',
    doc: { anchor: '7-tool-access-control-agenttoolkeys', slug: 'agents' },
    label: 'Tool',
  },
  trace: {
    definition:
      'The recorded steps of an agent’s work: its tool calls, model responses, and events. The run viewer shows them so you can see how a result was produced.',
    doc: { anchor: '8-agent-observability-agenttracer', slug: 'agents' },
    label: 'Trace',
  },
  version: {
    definition:
      'Every save of a template is a new, immutable version. A run stays pinned to the version it started with.',
    doc: { anchor: 'versioning-and-reproducibility', slug: 'architecture' },
    label: 'Version',
  },
  workflowTemplate: {
    definition:
      'A named, versioned workflow that says what steps a run takes and where it stops for a person. Built-in templates are seeded; teams clone and edit them or write their own.',
    doc: { anchor: 'workflows', slug: 'concepts' },
    label: 'Workflow template',
  },
  workspace: {
    definition:
      'The isolated Docker container an agent works in. The repository is cloned into it, and every command and file write is scanned before it runs.',
    doc: { anchor: 'agents', slug: 'concepts' },
    label: 'Workspace',
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryTerm = keyof typeof GLOSSARY;

export function glossaryEntry(term: GlossaryTerm): GlossaryEntry {
  return GLOSSARY[term];
}
