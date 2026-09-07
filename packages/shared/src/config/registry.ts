import { z } from 'zod';
import { DOCKER_IMAGE_REF_RE } from '../workflow/shellImageAllowlist.js';
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
const ratio = z.number().min(0).max(1);

/// Parses a positive-integer env var, clamping to `max` rather than rejecting.
/// A deployment that has always run `WORKER_MAX_CONCURRENT_ACTIVITIES=2000`
/// must not silently drop to the built-in 10 on upgrade because the schema caps
/// lower — that is a 200x throughput cut with no error. Clamp and say so.
function positiveIntEnv(max: number) {
  return (raw: string): number | undefined => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return undefined;
    }
    if (parsed > max) {
      console.warn(`[config] clamping env value ${parsed} to the maximum ${max}.`);
      return max;
    }
    return parsed;
  };
}

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

  // ── Repo dependency graph ──────────────────────────────────────────────────
  'repoDependency.scanCron': defineSetting({
    defaultValue: '0 4 * * *',
    description:
      'Cron expression (UTC) for the deterministic manifest/git-signal sweep that refreshes the repo dependency graph.',
    group: 'repoDependency',
    label: 'Dependency scan schedule',
    // Deployment-wide: the sweep spans every team's repos, so a per-team
    // override would have nothing to act on.
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.string().min(9),
  }),
  'repoDependency.scanEnabled': defineSetting({
    defaultValue: true,
    description:
      'Whether the scheduled repo-dependency sweep runs. Turning this off leaves the graph to manual edits and on-demand scans.',
    group: 'repoDependency',
    label: 'Run the dependency scan on a schedule',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
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
    schema: positiveInt.max(64),
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
  'workspace.blockMetadata': defineSetting({
    defaultValue: true,
    description:
      'Blackhole the cloud metadata IPs (AWS/GCP/Azure IMDS, ECS task metadata) inside every agent workspace. Leave this on unless it misbehaves on your Docker runtime — turning it off exposes instance credentials to agent-run code.',
    envVar: 'WORKSPACE_BLOCK_METADATA',
    group: 'workspace',
    label: 'Block cloud metadata endpoints',
    // A security control, so it is deliberately platform-wide and ADMIN-only:
    // no team should be able to switch off metadata blocking for its own runs.
    overridableAt: [],
    parseEnv: (raw) => raw !== 'false',
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
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
  'workspace.maxConcurrentActivities': defineSetting({
    defaultValue: 10,
    description:
      'Cap on Temporal activity tasks one worker runs at once. Most activities hold a Docker workspace, so raise it only if the Docker host can serve more in parallel. Takes effect when the worker restarts.',
    envVar: 'WORKER_MAX_CONCURRENT_ACTIVITIES',
    group: 'workspace',
    label: 'Worker activity concurrency',
    overridableAt: [],
    parseEnv: positiveIntEnv(1000),
    requiredRole: 'ADMIN',
    restartRequired: true,
    runPinned: false,
    schema: positiveInt.max(1000),
    unit: 'activities',
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
  'workspace.metadataBlockImage': defineSetting({
    defaultValue: 'alpine:3.20',
    description:
      'Image used for the privileged sidecar that installs the metadata blackhole routes. It needs `ip` from busybox and nothing else.',
    group: 'workspace',
    label: 'Metadata blocker image',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.string().min(1).max(200).regex(DOCKER_IMAGE_REF_RE),
  }),
  'workspace.regexScanBudgetMs': defineSetting({
    defaultValue: 250,
    description:
      'Wall-clock budget, in milliseconds, a scanner pattern gets before its pooled worker thread is killed and the pattern quarantined for this process. Every admin- or bundle-supplied scanner pattern runs against agent text under this bound — every `bash` command, every `writeFile` path, every skill save, every TDD iteration. Too low and an ordinary pattern trips it on a loaded host: a blocking scanner (shell command, sensitive file) spuriously blocks the agent, and a pattern that was never actually pathological gets quarantined and silently stops being enforced. Too high and one genuinely catastrophic pattern stalls that scan — and everything waiting behind it in the shared executor queue — for longer before the executor gives up and kills it.',
    envVar: 'SCANNER_REGEX_BUDGET_MS',
    group: 'workspace',
    label: 'Scanner regex execution budget',
    // A security control, so it is deliberately platform-wide and ADMIN-only:
    // no team should be able to loosen the bound that keeps a bad admin- or
    // bundle-supplied pattern from wedging the shared scanner executor.
    overridableAt: [],
    parseEnv: positiveIntEnv(60_000),
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.min(10).max(60_000),
    unit: 'ms',
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
