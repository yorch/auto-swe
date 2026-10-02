import { z } from 'zod';
import { AGENT_RUN_MAX_WALL_CLOCK_SECONDS } from '../lib/agentRun.js';
import { DOCKER_IMAGE_REF_RE } from '../workflow/shellImageAllowlist.js';
import { MAX_FANOUT_CONCURRENCY } from '../workflow/spec.js';
import type { SettingDefinition } from './types.js';

/**
 * The setting registry — one declaration per configurable knob.
 *
 * Every entry replaces a constant that used to be compiled into the worker, so
 * `defaultValue` is always the value that constant held. An unconfigured
 * deployment therefore behaves exactly as it did before the knob existed, and
 * an operator can change it from the dashboard instead of shipping a release.
 *
 * Adding a knob: add a definition here. Storage, validation, the API contract,
 * the admin form and the permission check all derive from it — there is no
 * migration, no Zod body schema, no form field to write.
 */

/// Identity helper: preserves the value type `T` through the definition so
/// `resolveSetting('channel.historyMessageLimit')` returns `number`, not
/// `unknown`, without every call site restating the type.
function defineSetting<T>(def: SettingDefinition<T>): SettingDefinition<T> {
  return def;
}

const positiveInt = z.number().int().positive();

/// A list of hosts a credential may be sent to, as `host` or `host:port`.
export const hostEntry = z
  .string()
  .regex(/^[a-z0-9.-]+(:[0-9]{1,5})?$/, 'must be a lowercase host or host:port')
  // A URL never carries the default port once parsed, so `host:443` would
  // never match anything — refuse it rather than let it look set.
  .refine((h) => !h.endsWith(':443'), 'omit the default port :443')
  .max(253);
const hostList = z.array(hostEntry).max(50);
const ratio = z.number().min(0).max(1);

export const SETTING_DEFINITIONS = {
  // ── Channel assistant ──────────────────────────────────────────────────────
  // The assistant's proactivity and context budgets. Every one of these was a
  // module-scope constant in `worker/src/activities/channel*.ts`, which made
  // "the bot is too chatty in this channel" a code change. They cascade to
  // CHANNEL so one noisy channel can be tuned without touching the others.
  //
  // Where SlackChannel already has a nullable column for the same knob, that
  // column still wins — these supply the default it falls back to, so a
  // per-channel override set in the Slack admin page keeps its meaning.
  'channel.historyMessageLimit': defineSetting({
    defaultValue: 30,
    description:
      'How many recent channel messages the assistant reads for context on a reactive pass. Higher gives better answers on long threads and costs more input tokens per turn.',
    group: 'channel',
    label: 'History window',
    overridableAt: ['CHANNEL', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(200),
    unit: 'messages',
  }),
  'channel.memoryContextItems': defineSetting({
    defaultValue: 5,
    description:
      'How many semantic-memory items are pulled into an assistant turn. Raising it grounds replies in more past context at the cost of prompt size.',
    group: 'channel',
    label: 'Memory items per turn',
    overridableAt: ['CHANNEL', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(50),
    unit: 'items',
  }),
  'channel.memoryDedupThreshold': defineSetting({
    defaultValue: 0.85,
    description:
      'Cosine similarity above which a new memory is treated as a duplicate of an existing one and dropped. Lower it to store fewer near-identical memories.',
    group: 'channel',
    label: 'Memory dedup threshold',
    overridableAt: ['CHANNEL', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: ratio,
    unit: '0–1',
  }),
  'channel.passiveIngestLimit': defineSetting({
    defaultValue: 50,
    description:
      'Maximum messages examined per passive-ingest sweep of a channel. Caps the cost of catching up after a quiet period.',
    group: 'channel',
    label: 'Passive ingest batch',
    overridableAt: ['CHANNEL', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(500),
    unit: 'messages',
  }),
  'channel.reactiveCooldownMinutes': defineSetting({
    defaultValue: 10,
    description:
      'Default minimum gap between unprompted interjections. A single channel is tuned on its own page, on the Slack channels admin screen — that per-channel value wins, and this is what a channel without one falls back to.',
    group: 'channel',
    label: 'Interjection cooldown',
    // Deliberately not CHANNEL: SlackChannel.reactiveCooldownMinutes is the
    // per-channel override and always outranks a registry row, so offering a
    // CHANNEL scope here would store a value the worker never reads — and the
    // effective-config view would report it as winning.
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10_080),
    unit: 'minutes',
  }),
  'channel.reactiveLookbackMinutes': defineSetting({
    defaultValue: 30,
    description:
      'Default window a reactive pass scans for conversation it has not evaluated yet. As with the cooldown, a channel tuned on the Slack channels admin screen uses its own value instead.',
    group: 'channel',
    label: 'Interjection lookback',
    // See the cooldown above: the SlackChannel column is the per-channel override.
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10_080),
    unit: 'minutes',
  }),
  'channel.threadContextMessages': defineSetting({
    defaultValue: 15,
    description:
      'How many messages of an existing thread the assistant reads before replying in it.',
    group: 'channel',
    label: 'Thread context window',
    overridableAt: ['CHANNEL', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(100),
    unit: 'messages',
  }),

  // ── GitHub hosts and per-user credentials ──────────────────────────────────
  // Where a GitHub credential may be sent, and whether a user may attach their
  // own token to a repository, used only for runs they launch. Deployment-wide
  // and ADMIN-only: each host list is an SSRF decision — it is what lets a
  // credential reach a private-network GitHub Enterprise server — and every
  // other connector reserves that decision for an admin.
  'github.repositoryHosts': defineSetting({
    defaultValue: [],
    description:
      "Hosts a repository's web or API URL override may point at, beyond the GitHub hosts configured on the GitHub integration (comma-separated host or host:port; github.com also covers api.github.com). A team lead may only point a repository at an approved host, and a repository already pointing elsewhere is refused outright until its host is listed. Listing a host does not send it the platform credential: that never leaves the instance's own host, so a repository on a listed host is reachable only with a user's own saved token.",
    group: 'github',
    label: 'Additional repository hosts',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: hostList,
    sensitive: true,
  }),
  'github.userCredentialHosts': defineSetting({
    defaultValue: ['github.com'],
    description:
      "Hosts a user's own GitHub token may be sent to, as host or host:port (comma-separated). Both the repository's web URL and its API URL must be listed; github.com also covers api.github.com. Listing a GitHub Enterprise host here is what permits it on a private network. An empty list stops every saved token from being saved or used.",
    group: 'github',
    label: 'Hosts allowed for user credentials',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: hostList,
    sensitive: true,
  }),
  'github.userCredentialsEnabled': defineSetting({
    defaultValue: false,
    description:
      'Whether users may attach their own GitHub token to a repository. A saved token is used only for runs its owner launches, ahead of the platform credential. Turning this off keeps saved tokens but stops using them.',
    group: 'github',
    label: 'Allow per-user GitHub credentials',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),

  // ── MCP server ─────────────────────────────────────────────────────────────
  'mcp.enabled': defineSetting({
    defaultValue: false,
    description:
      "Whether the platform serves MCP clients: the OAuth authorization server and the MCP endpoint. Off, the authorization server's endpoints, its discovery document, the MCP endpoint and its protected resource metadata return 404. Read through a ~30 s cache, so turning it off takes up to that long to apply on every replica.",
    group: 'mcp',
    label: 'Enable MCP access',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'mcp.writeToolsEnabled': defineSetting({
    defaultValue: false,
    description:
      'Whether MCP clients may be granted write access. Off, the mcp:write scope is refused at authorization and no access token that carries it is issued, on either the authorization-code or the refresh grant. A token already issued keeps the scope in its claims, but the MCP endpoint ignores it while this is off. Reads stay available while this is off.',
    group: 'mcp',
    label: 'Allow MCP write access',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),

  // ── Semantic memory ────────────────────────────────────────────────────────
  'memory.orgSimilarityThreshold': defineSetting({
    defaultValue: 0.7,
    description:
      'Cosine similarity a memory from another channel must clear before it is surfaced as an organisation-wide signal. Raise it to flag less, lower it to flag more.',
    group: 'memory',
    label: 'Org signal threshold',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: ratio,
    unit: '0–1',
  }),

  // ── Repository permission gating ───────────────────────────────────────────
  // Team membership says which repositories a user may reach; these decide
  // whether the source-control host has to agree. Deployment-wide, because a
  // per-team override would let one team opt out of the check that keeps the
  // platform's idea of access aligned with GitHub's. The sweep that refreshes
  // the cached answers is scheduled from the environment, not from here: see
  // `resolveScheduledSweeps`.
  'repoAccess.mode': defineSetting({
    defaultValue: 'off',
    description:
      "How the cached GitHub permission answers are used. 'off' ignores them entirely and access is team membership alone. 'advisory' logs every decision that would change but changes nothing — run here until the log is quiet and every active user has a GitHub login recorded. 'enforce' applies them.",
    group: 'repoAccess',
    label: 'GitHub permission gating',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.enum(['off', 'advisory', 'enforce']),
  }),
  'repoAccess.viewStaleAfterHours': defineSetting({
    defaultValue: 72,
    description:
      'How old a cached answer may be and still be trusted for viewing. Beyond this the row is ignored, so a repository whose answers stopped refreshing disappears from listings rather than being served indefinitely from a cache nobody is updating.',
    group: 'repoAccess',
    label: 'Cached answer lifetime (hours)',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().positive().max(8760),
  }),
  'repoDependency.autoPromoteThreshold': defineSetting({
    defaultValue: 0.9,
    description:
      'Confidence at or above which an LLM-inferred repo-dependency edge is promoted straight to active instead of waiting for a human confirm.',
    group: 'repoDependency',
    label: 'Auto-promote confidence threshold',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: ratio,
    unit: '0–1',
  }),

  // ── Workflow interpreter ───────────────────────────────────────────────────
  // These bound how a single run may expand. They are run-pinned: the
  // interpreter runs inside the Temporal V8 isolate and cannot read the
  // database, and a run that started under one transition ceiling must finish
  // under the same one or its replay history stops matching its code.
  'workflow.fanoutConcurrency': defineSetting({
    defaultValue: 4,
    description:
      'Default number of fan-out branches executed in parallel when a node does not set its own concurrency. Raise it to finish wide fan-outs sooner, at the cost of more simultaneous workspaces.',
    group: 'workflow',
    label: 'Fan-out concurrency',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: true,
    schema: positiveInt.max(MAX_FANOUT_CONCURRENCY),
    unit: 'branches',
  }),
  'workflow.maxTransitions': defineSetting({
    defaultValue: 500,
    description:
      'Hard ceiling on node transitions in one run — the backstop against a spec that loops forever. A run that hits it fails rather than burning budget indefinitely.',
    group: 'workflow',
    label: 'Max transitions per run',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: true,
    schema: positiveInt.max(100_000),
    unit: 'transitions',
  }),
  'workspace.agentMaxSteps': defineSetting({
    defaultValue: 50,
    description:
      'Ceiling on model steps in one implementer turn — every tool call (bash, readFile, writeFile, listDirectory, loadSkill, MCP) and the final answer each count as one. Applies to the implementer, the CI/review/gate fixers, the merge-conflict resolver, eval replays, and any agent node that carries tools (MCP). Without an explicit budget the agent framework stops after 5 steps, which ends a turn before the agent has read, edited and tested anything. Raise it for large changes; lower it to cap the tokens one turn can spend.',
    group: 'workspace',
    label: 'Max agent steps per turn',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.min(5).max(500),
    unit: 'steps',
  }),

  // ── Agent runs ─────────────────────────────────────────────────────────────
  // Ad-hoc "run this library agent on this repo" launches. Every one of these is
  // ADMIN-only: they bound what any ENGINEER can spend or publish from a text
  // box, so a LEAD who may tune the implementer's step budget must not be able
  // to raise them. A per-launch cap can only LOWER the ceilings below; the
  // gateway rejects a cap above one and the worker clamps again, because a
  // ceiling can drop between launch and start.
  'workspace.agentRunAllowWorkflowChanges': defineSetting({
    defaultValue: false,
    description:
      'Whether an agent run may publish changes under .github/workflows or .github/actions. A workflow file can request secrets and permissions that ordinary code cannot, so a run that touches one is refused unless this is on. This does NOT make a pushed branch safe: existing push-triggered workflows still run, with repository secrets, on whatever the agent changed elsewhere (package scripts, test files, build scripts).',
    group: 'workspace',
    label: 'Agent run: allow workflow file changes',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'workspace.agentRunMaxConcurrentGlobal': defineSetting({
    defaultValue: 4,
    description:
      'Most agent runs that may be in flight across the whole platform. Each holds a worker activity slot and a workspace container for its full duration, so this is what stops agent runs starving every other workflow. 0 disables agent runs.',
    group: 'workspace',
    label: 'Agent run: max concurrent (platform)',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(100),
    unit: 'runs',
  }),
  'workspace.agentRunMaxConcurrentPerTeam': defineSetting({
    defaultValue: 2,
    description:
      "Most agent runs one team (the repository's owning team) may have in flight. 0 disables agent runs for the team.",
    group: 'workspace',
    label: 'Agent run: max concurrent (per team)',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(100),
    unit: 'runs',
  }),

  'workspace.agentRunMaxSteps': defineSetting({
    defaultValue: 50,
    description:
      'Ceiling on model steps in one agent run (every tool call and the final answer count as one). A launch may request fewer, never more. Each step re-checks the run budget, so a lower ceiling mainly bounds latency and how far one run can overshoot its tier.',
    group: 'workspace',
    label: 'Agent run: max steps',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(500),
    unit: 'steps',
  }),
  'workspace.agentRunMaxWallClockSeconds': defineSetting({
    defaultValue: 1800,
    description:
      'Ceiling on the wall-clock time an agent run may spend in the agent loop. A launch may request less, never more. A run that hits it stops where it is; changes made so far are still checked and, when delivery was requested, still published.',
    group: 'workspace',
    label: 'Agent run: max wall-clock time',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.min(60).max(AGENT_RUN_MAX_WALL_CLOCK_SECONDS),
    unit: 'seconds',
  }),

  // ── Shell-step helper image ────────────────────────────────────────────────
  // Cascades to TEAM / ORGANIZATION, unlike the rest of the workspace
  // infrastructure (which is environment-only): a team on an isolated network
  // may need its own mirror of the image, so this one stays an admin-set value.
  'workspace.gitHelperImage': defineSetting({
    defaultValue: 'alpine/git:latest',
    description:
      'Image used for the short-lived container that performs git operations for a shell step. Pin a digest here to stop tracking the upstream tag.',
    group: 'workspace',
    label: 'Git helper image',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.string().min(1).max(200).regex(DOCKER_IMAGE_REF_RE),
  }),

  // ── Agent workspace ────────────────────────────────────────────────────────
  // Tunes the implementer's tool behaviour rather than the container itself,
  // but there is no `implementer` group (only channel/memory/workflow/workspace
  // exist), and every key must share its group's prefix (see the
  // `SETTING_DEFINITIONS` integrity test), so it's named and grouped here.
  'workspace.maxToolOutputChars': defineSetting({
    defaultValue: 20_000,
    description:
      'Character ceiling on a single bash/readFile/listDirectory result handed to the implementer. Output over this limit is written in full to a file inside the workspace (outside the git repo, so it never reaches the PR diff) and replaced with a head+tail excerpt plus a pointer to read the rest. Raise it to give the model more of one large output in context at the cost of prompt size — the full output is preserved either way.',
    group: 'workspace',
    label: 'Max tool output size',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.min(1_000).max(200_000),
    unit: 'characters',
  }),
} as const satisfies Record<string, SettingDefinition<unknown>>;

/// Every registry key. Used to type `resolveSetting` and to validate an
/// incoming key at the API boundary.
export type SettingKey = keyof typeof SETTING_DEFINITIONS;

/// The value type a given key resolves to.
export type SettingValue<K extends SettingKey> =
  (typeof SETTING_DEFINITIONS)[K] extends SettingDefinition<infer T> ? T : never;

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_DEFINITIONS, key);
}

export function getSettingDefinition<K extends SettingKey>(
  key: K
): (typeof SETTING_DEFINITIONS)[K] {
  return SETTING_DEFINITIONS[key];
}

/// The keys snapshotted onto a run at start. Everything else re-resolves live.
export const RUN_PINNED_SETTING_KEYS = SETTING_KEYS.filter(
  (key) => SETTING_DEFINITIONS[key].runPinned
);
