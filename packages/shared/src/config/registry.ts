import { z } from 'zod';
import { AGENT_RUN_MAX_WALL_CLOCK_SECONDS } from '../lib/agentRun.js';
import { GlobListSchema } from '../lib/ciTrigger.js';
import {
  type EgressPolicy,
  egressPolicySchema,
  type SetupEgressPolicy,
  setupEgressPolicySchema,
} from '../lib/egressPolicy.js';
import { hasGitNameCharacter } from '../lib/gitIdentityName.js';
import {
  countGlobStars,
  DEFAULT_BOT_APPROVAL_PATHS,
  globCost,
  isValidGlob,
  MAX_BOT_APPROVAL_PATHS,
  MAX_GLOB_LENGTH,
  MAX_GLOB_STARS,
} from '../lib/prEvaluation/paths.js';
import { MAX_FILE_GLOB_COST } from '../lib/prEvaluation/policy.js';
import {
  REVIEW_RISK_CLASSES,
  reviewRoutingLineCount,
  reviewRoutingPathsSchema,
} from '../lib/prEvaluation/reviewRouting.js';
import { CONVENTIONAL_COMMIT_TYPES, PR_TITLE_FORMATS } from '../lib/prTitle.js';
import { IMPLEMENTER_RUNTIMES } from '../types/api.js';
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
  // `ghe.corp.` is a spelling of `ghe.corp` that no URL comparison here treats as equal.
  .refine((h) => !h.split(':')[0].endsWith('.'), 'omit the trailing dot')
  .max(253);
const hostList = z.array(hostEntry).max(50);
/// A GitHub organization login: alphanumerics and single hyphens, at most 39
/// characters, lowercase because GitHub treats logins case-insensitively and
/// the stored form is the one compared and sent.
const githubOrgLogin = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be a lowercase GitHub organization login')
  .max(39);
/// Extra sensitive-path globs: may be empty (the built-in list always applies), bounded in
/// count and length so a stored value cannot become a regex-cost or payload problem.
const prEvaluationSensitivePaths = z.array(z.string().trim().min(1).max(200)).max(100);
/// The bot approval allowlist: each glob valid and bounded exactly as a repository policy file's
/// globs are, few of them, and cheap enough together to run against every changed path. May be
/// empty, which means no path qualifies.
const prEvaluationBotApprovalPaths = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_GLOB_LENGTH)
      .refine(isValidGlob, 'not a valid glob')
      .refine((g) => countGlobStars(g) <= MAX_GLOB_STARS, `more than ${MAX_GLOB_STARS} * tokens`)
  )
  .max(MAX_BOT_APPROVAL_PATHS)
  .refine(
    (list) => list.reduce((sum, g) => sum + globCost(g), 0) <= MAX_FILE_GLOB_COST,
    'globs are too expensive to evaluate together'
  );
/// A GitHub commit status context: printable, no whitespace edges, bounded.
const prEvaluationStatusContext = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/:-]*$/, 'must be a plain status context name')
  .max(100);
const ratio = z.number().min(0).max(1);
/// An `owner/repo` on the GitHub tracker's host. The characters are the ones
/// `parseGitHubTicketId` accepts in a ticket id, so an entry can only ever name
/// what a ticket id can; `.` and `..` are legal there but would rewrite the
/// request path once interpolated. Case is kept as typed (GitHub compares
/// case-insensitively, and so does the scope check) but a repeat is dropped.
const trackerIssueRepository = z
  .string()
  .trim()
  .max(200)
  .regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/repo')
  .refine((v) => v.split('/').every((part) => part !== '.' && part !== '..'), 'must be owner/repo');
const trackerIssueRepositoryList = z
  .array(trackerIssueRepository)
  .max(50)
  .transform((entries) => {
    const seen = new Set<string>();
    return entries.filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  });
/// Git identity fields end up inside a commit header, where a control
/// character or angle bracket would corrupt the `Name <email>` line. The email
/// is deliberately not `z.email()`: the default `auto-swe@localhost` has no TLD.
const GIT_IDENTITY_FORBIDDEN_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}<>]/u;
const gitIdentityName = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => v.trim().length > 0, 'must not be blank')
  .refine((v) => !GIT_IDENTITY_FORBIDDEN_RE.test(v), 'must not contain control characters, < or >')
  .refine(hasGitNameCharacter, 'must contain a character git accepts in a name');
const gitIdentityEmail = z
  .string()
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+$/, 'must contain exactly one @ and no whitespace')
  .refine((v) => !GIT_IDENTITY_FORBIDDEN_RE.test(v), 'must not contain control characters, < or >');
/// How serious a Qodo finding is, most serious first.
const qodoActionLevel = z.enum(['action_required', 'remediation_recommended', 'informational']);
type QodoActionLevel = z.infer<typeof qodoActionLevel>;

/// LiteLLM's community-maintained price table: per-token prices for the major
/// providers and most OpenAI-compatible hosts, keyed by model id.
export const DEFAULT_MODEL_PRICE_LIST_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const SETTING_DEFINITIONS = {
  // ── First-party activity events ────────────────────────────────────────────
  // Read by the gateway (the UI-event route) and the daily retention sweep, neither of
  // which has a team: GLOBAL only.
  'analytics.activityRetentionDays': defineSetting({
    defaultValue: 90,
    description:
      'How long recorded user-activity events (denied requests, sensitive reads and exports, page views) are kept before the daily retention sweep deletes them.',
    group: 'analytics',
    label: 'Activity event retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(7).max(3650),
    unit: 'days',
  }),
  'analytics.orgWideReports': defineSetting({
    defaultValue: false,
    description: 'Whether platform admins enable organization-wide reporting data and digests.',
    group: 'analytics',
    label: 'Organization-wide reports',
    overridableAt: ['ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'analytics.uiEventsEnabled': defineSetting({
    defaultValue: false,
    description:
      'Whether the dashboard reports which page a signed-in person opens (the route pattern only: no ids, no query string). Off, the endpoint accepts nothing and the browser stops sending. Browsers that send Do Not Track never report.',
    group: 'analytics',
    label: 'Page-view events enabled',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),

  // ── In-app assistant ───────────────────────────────────────────────────────
  // The kill switch for the dashboard assistant. Read by `requireAuth` on every
  // request that carries an assistant token, so turning it off refuses the
  // assistant's in-flight calls as well as new conversations.
  'assistant.enabled': defineSetting({
    defaultValue: false,
    description:
      'Whether the in-app assistant may act. Off, the gateway refuses every request made with an assistant token, so a conversation already running stops at its next call. Read through a ~30 s cache, so turning it off takes up to that long to apply on every replica.',
    group: 'assistant',
    label: 'Enable the in-app assistant',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  // Read by the conversation workflow's turn activity at the start of every turn.
  'assistant.generateTitles': defineSetting({
    defaultValue: true,
    description:
      "Whether the assistantTitler agent names each conversation from the person's first messages. Its model is set in the agent library. Off, a conversation keeps the start of its first message as its title until the person renames it.",
    group: 'assistant',
    label: 'Name conversations with the model',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  // Read by the conversation workflow's turn activity at the start of every turn.
  'assistant.maxStepsPerTurn': defineSetting({
    defaultValue: 12,
    description:
      'How many model steps one assistant reply may take, each tool call being one. A reply that reaches the limit ends with what it has and says so. Higher lets the assistant look further before answering and costs more per reply.',
    group: 'assistant',
    label: 'Steps per reply',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(50),
    unit: 'steps',
  }),

  // ── Audit log ──────────────────────────────────────────────────────────────
  // Read by the daily retention sweep, which has no team: GLOBAL only. `0` keeps the log
  // forever (the settings form edits numbers, booleans and lists, so "unset" is a number).
  // A non-zero value is held to at least a year: the log is the record of who changed what.
  'audit.configLogRetentionDays': defineSetting({
    defaultValue: 0,
    description:
      'How long administrative audit-log rows are kept before the daily retention sweep deletes them. 0 keeps them forever; otherwise at least 365 days. The sweep records one summary row of its own.',
    group: 'audit',
    label: 'Audit log retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z
      .number()
      .int()
      .max(3650)
      .refine((days) => days === 0 || days >= 365, 'must be 0 (keep forever) or at least 365'),
    unit: 'days (0 = forever)',
  }),

  // Read by the same daily sweep. Effect rows are a run-scoped record of what the run changed
  // outside the sandbox and outlive their run; `0` keeps them forever, otherwise at least a month.
  'audit.runEffectRetentionDays': defineSetting({
    defaultValue: 0,
    description:
      'How long run-effect rows (what a run changed outside the sandbox: MCP writes, pull requests, pushes, tracker and knowledge-base writes) are kept before the daily retention sweep deletes them. 0 keeps them forever; otherwise at least 30 days.',
    group: 'audit',
    label: 'Run effect retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z
      .number()
      .int()
      .max(3650)
      .refine((days) => days === 0 || days >= 30, 'must be 0 (keep forever) or at least 30'),
    unit: 'days (0 = forever)',
  }),

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

  // ── Eval benchmark ─────────────────────────────────────────────────────────
  // Read by flake screening, which runs on cases of every tenant from one
  // deployment-wide sweep: GLOBAL only.
  'evals.flakeScreenRuns': defineSetting({
    defaultValue: 3,
    description:
      "How many times a benchmark case's reference (its golden test at the pinned commit) is run when the case is screened for flakiness. A case is scored by the regression harness only once its reference passed every one of these runs; one that failed any run is excluded as flaky. Each run provisions a workspace and runs the golden test, so this multiplies screening cost. A change applies to cases screened afterwards; cases already screened keep their result.",
    group: 'evals',
    label: 'Flake-screen runs per case',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(20),
    unit: 'runs',
  }),

  // ── Git commit identity ────────────────────────────────────────────────────
  // The author and committer written on every commit a workspace makes, so a
  // deployment can present its own identity instead of the platform's.
  'git.authorEmail': defineSetting({
    defaultValue: 'auto-swe@localhost',
    description:
      'Email address written as the author and committer of every commit the platform makes. Not validated as a deliverable address: the default has no domain suffix.',
    group: 'git',
    label: 'Commit author email',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: gitIdentityEmail,
  }),
  'git.authorName': defineSetting({
    defaultValue: 'auto-swe',
    description:
      'Name written as the author and committer of every commit the platform makes. Up to 100 characters, with no control characters, "<" or ">", and at least one character other than whitespace and . , : ; " \' \\.',
    group: 'git',
    label: 'Commit author name',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: gitIdentityName,
  }),
  'git.launcherAttribution': defineSetting({
    defaultValue: 'none',
    description:
      'Whether the person who launched a run is credited on its commits. "none" credits no one, "co-author-trailer" adds a Co-authored-by trailer to each commit message, and "author" makes the launcher the commit author.',
    group: 'git',
    label: 'Launcher attribution',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.enum(['none', 'co-author-trailer', 'author']),
  }),

  // ── GitHub hosts and per-user credentials ──────────────────────────────────
  // Where a GitHub credential may be sent, and whether a user may attach their
  // own token to a repository, used only for runs they launch. Deployment-wide
  // and ADMIN-only: each host list is an SSRF decision — it is what lets a
  // credential reach a private-network GitHub Enterprise server — and every
  // other connector reserves that decision for an admin.
  'github.ciFailureTriggersEnabled': defineSetting({
    defaultValue: true,
    description:
      "Whether a repository's CI-failure triggers may start runs. Each trigger is opt-in on its repository already; this is the switch that stops every one of them at once — a webhook for a failed workflow run is then acknowledged and recorded nowhere. Turning it off does not stop runs already started.",
    group: 'github',
    label: 'CI-failure triggers enabled',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'github.ciFixNeverPushBranches': defineSetting({
    defaultValue: ['main', 'master', 'develop', 'trunk', 'release/**', 'releases/**', 'hotfix/**'],
    description:
      "Branches a CI fix is never pushed to, even where a trigger's pull-request fix delivery is 'push' and pushing is allowed: globs over the branch name (* within a path segment, ** across them, a leading ! excludes; the last match wins). The repository's default branch and any protected branch are refused whatever this says; a refused push becomes a draft pull request instead.",
    group: 'github',
    label: 'CI fixes are never pushed to',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: GlobListSchema,
  }),
  'github.ciFixPushToPullRequestEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a CI-failure trigger may deliver a fix for a failing pull request as a commit pushed to that pull request's own branch, rather than as a draft pull request into it. Off: every fix is a draft pull request, whatever a trigger asks for. A pushed commit is reviewed only as part of the pull request it lands on, so this moves agent-written code one step closer to a merge. Even when on, the push is fast-forward only, never to the default branch, a protected branch or one matching 'CI fixes are never pushed to', and only with the built-in CI triage template; anything refused becomes a draft pull request.",
    group: 'github',
    label: 'CI fixes may be pushed to pull request branches',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  // Read by the fix sessions (`runImplementerFixSession`: CI_FIX, GATE_FIX, PR_FEEDBACK) and by
  // `executeImplementation` when the step carries `refuseWorkflowChanges` (the ci-triage fix),
  // with the repository's team. Resolved before the agent session starts.
  'github.ciFixTestIntegrityGuard': defineSetting({
    defaultValue: 'warn',
    description:
      "What a fix session does when the change it made deletes a test file or test case, adds a skip, focus or expected-failure marker, removes or loosens assertions, changes the test command or CI so failures are ignored, or changes test configuration to exclude tests or lower a coverage threshold. Covers the CI-fix, quality-gate-fix and pull-request-feedback fix sessions and the ci-triage-and-fix implement step. 'warn' (default): the change goes through and the findings are recorded on the run and counted in the outcome report. 'block': the change is committed without hooks, its diff is analysed, and a high-severity finding stops the step with TEST_INTEGRITY_GUARD before anything is pushed; the step then follows its template's failure route, and the fixer is not told why it failed. 'off': not checked. A heuristic over the diff text with false positives (a consolidation of tests, a deleted test for removed code) and false negatives (an assertion moved into a helper, a failing test rewritten to expect the wrong value), so a clean result is not a proof the tests are intact. Overridable per team or organization, not per repository.",
    group: 'github',
    label: 'Fix-session test-integrity guard',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.enum(['off', 'warn', 'block']),
  }),
  'github.issueLabelAutomationsEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a repository's issue-label automations may start runs. Off by default: a label added to an issue starts a template on the issue's text, so an admin turns this on deliberately. Even when on, a labelling starts a run only when the person who added the label is an active platform user with a linked GitHub account and a member of the repository; issue forms add labels for whoever opens the issue, so the label alone says nothing about who asked. Turning it off does not stop runs already started.",
    group: 'github',
    label: 'Issue-label automations enabled',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'github.prFeedbackAutomationsEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a repository's pull-request feedback automations may start runs. Off by default: a review requesting changes or an `/auto-swe fix` comment starts a template that edits a pull request, so an admin turns this on deliberately. Even when on, feedback starts a run only when the person who left it is an active platform user with a linked GitHub account and a member of the repository. Turning it off does not stop runs already started.",
    group: 'github',
    label: 'Pull-request feedback automations enabled',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'github.prFeedbackOtherPullRequestsEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a pull-request feedback automation may act on a pull request the platform did not open — and then only through the explicit `/auto-swe fix` command, never a review requesting changes. Off by default: the fix is pushed to that person's pull request branch, so an admin grants it deliberately. Pushes stay fast-forward only, never to the default branch, a protected branch, a fork head, or one matching 'CI fixes are never pushed to'.",
    group: 'github',
    label: 'Feedback may act on any pull request',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'github.prLabelAutomationsEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a repository's pull-request label automations may start runs. Off by default: a label added to a pull request starts a template on the pull request's title and body, which whoever opened it wrote, so an admin turns this on deliberately. Even when on, a labelling starts a run only when the person who added the label is an active platform user with a linked GitHub account and a member of the repository, and never for a pull request from a fork. Turning it off does not stop runs already started.",
    group: 'github',
    label: 'Pull-request label automations enabled',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'github.pushAutomationsEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a repository's push automations may start runs. Off by default: a push starts a template on a commit message and changed files that someone else wrote (after a squash merge the message is the pull request's own text, whose author may be outside the repository), so an admin turns this on deliberately. Even when on, a push starts a run only on a branch the automation names, never on a branch under the platform's current work-branch prefix (a branch made under an earlier prefix is not covered), and only when the pusher is an active platform user with a linked GitHub account and a member of the repository. A commit that a CI-fix or pull-request-feedback run pushed to a person's own pull-request branch is not under that prefix; it is recognised only as the platform's own output and not acted on again. Turning it off does not stop runs already started.",
    group: 'github',
    label: 'Push automations enabled',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'github.repositoryHosts': defineSetting({
    defaultValue: [],
    description:
      "Hosts a repository's web or API URL override may point at, beyond the GitHub hosts configured on the GitHub integration (comma-separated host or host:port; github.com also covers api.github.com). A team lead may only point a repository at an approved host, and a repository already pointing elsewhere is refused outright until its host is listed. Listing a host approves where a repository may point; it does not by itself send that host any credential. The instance's own platform credential never leaves the instance's host. A repository on a listed host uses that host's own PAT or GitHub App when an admin has saved one under Admin > Integrations > GitHub > Per-host credentials; with none, runs that have no saved user token fail with REPO_CREDENTIAL_HOST_MISMATCH; only a user's own saved token reaches that host.",
    group: 'github',
    label: 'Additional repository hosts',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: hostList,
    sensitive: true,
  }),
  'github.signInAutoApproveOrgs': defineSetting({
    defaultValue: [],
    description:
      "GitHub organizations whose members are approved automatically when they first sign in with GitHub, skipping the approval queue. Empty turns auto-approval off. Membership is checked with the platform GitHub credential against the instance's own GitHub host, so the credential needs permission to read organization members; any error, a private membership it cannot see, or a missing GitHub login leaves the user waiting for an admin. Approved users get the ENGINEER role and join the default team like any other sign-up, and a deactivated account is never re-approved. Lowercase organization logins, comma-separated. Read through a ~30 s cache, so removing an organization takes up to that long to apply.",
    group: 'github',
    label: 'Auto-approve sign-ins from organizations',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.array(githubOrgLogin).max(50),
    sensitive: true,
  }),
  'github.trackerIssueRepositories': defineSetting({
    defaultValue: [],
    description:
      "Repositories, as owner/repo on the GitHub issue tracker's own host, whose issues a run may read and write beyond the repositories it targets. A run's ticket may name only a repository the run targets; a deployment that keeps its tickets in a separate issues repository lists it here, so `acme/issues#5` works for a run on `acme/app`. Only an admin can list one, because each entry widens what the platform's tracker token can read and write for every run in scope. A bare issue number still means the run's own repository, never one listed here. The tracker is only ever called at its configured base URL, so an entry cannot reach another host. Up to 50 repositories, compared case-insensitively. Read through a ~30 s cache, so removing an entry takes up to that long to apply. A value that cannot be loaded is treated as an empty list.",
    group: 'github',
    label: 'Extra issue-tracker repositories',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: trackerIssueRepositoryList,
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
  'mcp.agentRunAllowedDeliverModes': defineSetting({
    defaultValue: ['none', 'draft_pr'],
    description:
      'Delivery modes allowed for agent runs launched through MCP. Other launch paths are unchanged.',
    group: 'mcp',
    label: 'MCP agent run delivery modes',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.array(z.enum(['none', 'draft_pr', 'branch'])),
  }),
  'mcp.deviceFlowEnabled': defineSetting({
    defaultValue: false,
    description:
      'Allow registered MCP clients to request device authorization. A signed-in active user approves the exact requested scopes in the browser.',
    group: 'mcp',
    label: 'Enable MCP device authorization',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
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
  'mcp.maxConcurrentRuns': defineSetting({
    defaultValue: 2,
    description:
      'The most runs one user may have in flight before MCP refuses another submit_work_request. Every run counts, including ones the user started from the dashboard or the CLI, so it bounds what an agent acting for that user can have running in total. Checked under a per-user lock when a run is recorded, so parallel MCP submissions cannot exceed it; runs started from the dashboard or the CLI at the same instant do not take that lock and can exceed it, by as many as are launched concurrently. A run left non-terminal by a crash, an external terminate or a workflow that failed before its run row was created keeps counting until its row is set to a terminal status. Read on every call, so a change applies within the ~30 s settings cache and needs no restart.',
    group: 'mcp',
    label: 'MCP concurrent runs per user',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(50),
    unit: 'runs',
  }),

  'mcp.templateRunsEnabled': defineSetting({
    defaultValue: false,
    description:
      'Allow MCP clients to launch workflow templates, which may execute authored code and push branches. Other launch paths are unchanged.',
    group: 'mcp',
    label: 'Enable MCP template launches',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'mcp.writeCallsPerMinute': defineSetting({
    defaultValue: 10,
    description:
      'The most write tool calls (submit_work_request and cancel_run) one user may make through MCP in a minute, counting refused ones. It counts calls to the underlying routes, not tool calls: cancelling the runs of a work request by its id spends one per own run attempted, refused attempts included. Counted per gateway process, so with several replicas a user can reach this many per replica. Read on every call, so a change applies within the ~30 s settings cache and needs no restart.',
    group: 'mcp',
    label: 'MCP write calls per minute',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(600),
    unit: 'calls/min',
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

  'memory.knowledgeMaxResults': defineSetting({
    defaultValue: 5,
    description: 'Maximum governed knowledge results returned to an agent in one retrieval.',
    group: 'memory',
    label: 'Knowledge retrieval result limit',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.min(1).max(10),
    unit: 'results',
  }),

  // ── Semantic memory ────────────────────────────────────────────────────────
  'memory.lessonFlagQuarantineThreshold': defineSetting({
    defaultValue: 2,
    description:
      'Distinct flags that quarantine a repository lesson and exclude it from agent recall. 0 disables automatic quarantine. Resolved at the repository owning team and organization; changing it does not sweep existing lessons.',
    group: 'memory',
    label: 'Lesson flag quarantine threshold',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(20),
    unit: 'flags',
  }),
  'memory.lessonMaxAgeDays': defineSetting({
    defaultValue: 0,
    description:
      'Days after which a lesson is no longer recalled into a prompt, returned by searchLessons, or merged by consolidation. The lesson stays stored and listed. 0 keeps every lesson in recall, whatever its age.',
    group: 'memory',
    label: 'Lesson maximum age',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(36_500),
    unit: 'days',
  }),
  'memory.lessonTranscriptEvidence': defineSetting({
    defaultValue: true,
    description:
      "Whether the lesson writer is given a digest of the implementer's own transcripts: the shell commands that failed, the other tool calls that failed, the files written three or more times, and each session's last notes. Extracted by code from the run's latest three implementer transcripts, bounded to 4,000 characters, and screened by the memory gate's injection scan. Off, the transcripts are not read.",
    group: 'memory',
    label: 'Transcript evidence for lessons',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
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
  'memory.supersedeThreshold': defineSetting({
    defaultValue: 0.92,
    description:
      'Cosine similarity at which a newly written memory replaces an older one in the same repository or channel. The older item is kept but no longer recalled. Lower it to replace more aggressively; 1 turns replacement off.',
    group: 'memory',
    label: 'Supersede threshold',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: ratio,
    unit: '0–1',
  }),

  'models.priceListUrl': defineSetting({
    defaultValue: DEFAULT_MODEL_PRICE_LIST_URL,
    description:
      "A community price list in LiteLLM's model_prices_and_context_window.json format, which suggests a new model's prices to the catalog's Add form and bulk add, and gives the scheduled catalog refresh figures to cross-check. Suggestions only: an admin still saves each price, and nothing costs a call from the list. Empty turns the lookup off. The gateway and the worker each fetch it behind the same address guard as provider credentials (a private-network mirror needs its host in models.privateNetworkHosts), refuse redirects, and cache it for six hours.",
    group: 'models',
    label: 'Model price list URL',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.union([z.literal(''), z.string().url().max(2000)]),
    // A mirror's URL can name a server on a private network.
    sensitive: true,
  }),

  // ── Models ─────────────────────────────────────────────────────────────────
  'models.privateNetworkHosts': defineSetting({
    defaultValue: [],
    description:
      "Hosts a provider credential's apiBase may point at even though the host is, or resolves to, a private-network address (comma-separated host or host:port, e.g. internal.example.com or 10.0.0.5:8000). Saving checks the apiBase as text only; the Test button, model discovery, the catalog refresh and run-time inference, embedding and Claude Code model-proxy calls resolve the name and pin the connection to a checked address, and run-time calls also refuse redirects. Listing a host lifts the private-address refusal at each of these. Loopback and localhost, link-local and cloud metadata addresses (169.254.0.0/16, fd00:ec2::254, 100.100.100.200) stay refused whatever is listed, as are unspecified, multicast and reserved addresses. If the setting cannot be read, no host is listed. Under an environment proxy (NODE_USE_ENV_PROXY) the host is checked but the connection is not pinned, and a Claude Code harness run without the model proxy is outside the guard. A listed name is trusted to mean the server you intend.",
    group: 'models',
    label: 'Private-network model provider hosts',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: hostList,
    sensitive: true,
  }),

  // ── Pull request evaluation ────────────────────────────────────────────────
  // Risk class, approver counts and the auto-merge gate for the pull requests the
  // platform opens. Every knob is ADMIN-only: each one moves a safety floor.
  'prEvaluation.autoEvidenceMinChangedLines': defineSetting({
    defaultValue: 10,
    description:
      'The fewest changed lines (additions plus deletions) a merged low-risk pull request may have and still count as evidence for auto mode, so trivial one-line changes do not build the record.',
    group: 'prEvaluation',
    label: 'Minimum changed lines for evidence',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10000),
    unit: 'lines',
  }),
  'prEvaluation.autoMergeAllowed': defineSetting({
    defaultValue: false,
    description:
      'Whether a repository set to auto mode may ask GitHub to auto-merge a low-risk pull request the platform opened. Off, auto mode behaves as advisory. Deployment-wide: it is the one switch that lets the platform enable GitHub auto-merge at all.',
    group: 'prEvaluation',
    label: 'Allow auto-merge',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'prEvaluation.autoMinDistinctRequesters': defineSetting({
    defaultValue: 3,
    description:
      'How many different requesters (platform user accounts) must have requested the work behind the qualifying low-risk merges counted for auto mode, so one person cannot supply the whole track record.',
    group: 'prEvaluation',
    label: 'Distinct requesters required for auto mode',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(1000),
    unit: 'requesters',
  }),
  'prEvaluation.autoMinEvidence': defineSetting({
    defaultValue: 150,
    description:
      'How many low-risk pull requests merged in the last 90 days, with none reverted or marked a bad merge, a deployment needs before any repository may use auto mode.',
    group: 'prEvaluation',
    label: 'Evidence required for auto mode',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10000),
    unit: 'pull requests',
  }),
  'prEvaluation.autoMinRepoEvidence': defineSetting({
    defaultValue: 20,
    description:
      'How many qualifying low-risk pull requests merged in this repository in the last 90 days, with none marked a bad merge, a repository needs before it may use auto mode. Counted in addition to the deployment-wide minimum.',
    group: 'prEvaluation',
    label: 'Evidence required per repository for auto mode',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10000),
    unit: 'pull requests',
  }),
  'prEvaluation.botApprovalAllowed': defineSetting({
    defaultValue: false,
    description:
      'The second key for bot approval: whether the approver App may approve low-risk pull requests of a repository whose administrator has turned bot approval on, so they merge with no human approval. Requires prEvaluation.autoMergeAllowed and a configured approver App. Deployment-wide; turning it off withdraws approvals through a re-evaluation of open pull requests.',
    group: 'prEvaluation',
    label: 'Allow bot approval',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'prEvaluation.botApprovalMaxFiles': defineSetting({
    defaultValue: 3,
    description:
      'Most files a pull request may change and still be approved by the approver App with no human. A hard cap beside the low-risk class, which allows more. Counts every listed file.',
    group: 'prEvaluation',
    label: 'Most files for bot approval',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(15),
    unit: 'files',
  }),
  'prEvaluation.botApprovalMaxLines': defineSetting({
    defaultValue: 50,
    description:
      'Most changed lines (added plus deleted, over every listed file) a pull request may carry and still be approved by the approver App with no human. A hard cap beside the low-risk class, which allows more.',
    group: 'prEvaluation',
    label: 'Most changed lines for bot approval',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(400),
    unit: 'lines',
  }),
  'prEvaluation.botApprovalPaths': defineSetting({
    defaultValue: [...DEFAULT_BOT_APPROVAL_PATHS],
    description:
      'Globs of the paths the approver App may approve: every changed path of a pull request (and the previous path of a rename) must match one, on top of the other bot approval conditions. A sensitive path still makes the change high risk first. An EMPTY list means no path qualifies, so the bot never approves (it fails closed). Matched case-insensitively on the repository-relative path; at most 50 globs. Deployment-wide; changing it withdraws approvals that no longer qualify through a re-evaluation of open pull requests.',
    group: 'prEvaluation',
    label: 'Paths the bot may approve',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: prEvaluationBotApprovalPaths,
  }),
  'prEvaluation.defaultMode': defineSetting({
    defaultValue: 'advisory',
    description:
      'The evaluation mode of a repository that has not chosen one: off evaluates nothing, advisory posts a commit status and a review brief, enforce also holds the status pending until enough approvals exist (never arming auto-merge). Auto is never a default; it is a per-repository choice.',
    group: 'prEvaluation',
    label: 'Default evaluation mode',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.enum(['off', 'advisory', 'enforce']),
  }),
  'prEvaluation.enabled': defineSetting({
    defaultValue: false,
    description:
      'Whether the platform evaluates the risk of the pull requests it opens. Off, no evaluation runs and no commit status is posted, whatever a repository chose. The kill switch for the feature.',
    group: 'prEvaluation',
    label: 'Enable pull request evaluation',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'prEvaluation.highApprovers': defineSetting({
    defaultValue: 2,
    description: 'Approving reviews required on a pull request classed high risk.',
    group: 'prEvaluation',
    label: 'Approvers for high-risk pull requests',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10),
    unit: 'approvers',
  }),
  'prEvaluation.highLines': defineSetting({
    defaultValue: 1000,
    description:
      'Changed lines (additions plus deletions, excluding files proven safe to skim) above which a pull request is classed high risk.',
    group: 'prEvaluation',
    label: 'High-risk line threshold',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(1000000),
    unit: 'lines',
  }),
  'prEvaluation.humanAboveLines': defineSetting({
    defaultValue: 0,
    description:
      'Review routing: a ready pull request with more changed lines than this asks for a person, whatever its risk class, unless the approvals it needs already stand. 0 turns the size rule off. A repository override can only lower it or turn it on: the stricter of the two applies, so a looser repository value has no effect, and loosening it for one repository is not supported (change this setting at its team or organization). Routing orders and labels the review queue; it never changes the approvals a pull request needs.',
    group: 'prEvaluation',
    label: 'Routing: always ask for a person above',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: reviewRoutingLineCount,
    unit: 'lines',
  }),
  'prEvaluation.humanMinRisk': defineSetting({
    defaultValue: 'LOW',
    description:
      'Review routing: the lowest risk class that asks for a person, unless the approvals the pull request needs already stand. LOW asks for a person on every ready, evaluated pull request that does not have its approvals; STANDARD leaves low-risk changes off the attention queue; HIGH keeps only high-risk ones. A repository override can only lower it: the stricter of the two applies, so a higher repository value has no effect (change this setting at its team or organization to raise it). Routing orders and labels the review queue; it never changes the approvals a pull request needs.',
    group: 'prEvaluation',
    label: 'Routing: lowest risk that asks for a person',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.enum(REVIEW_RISK_CLASSES),
  }),
  'prEvaluation.humanPaths': defineSetting({
    defaultValue: [],
    description:
      'Review routing: globs of paths whose change always asks for a person, whatever approvals already stand, so a pull request that matches one stays on the attention queue until it is merged or closed. Matched against every changed file and the previous path of a renamed one. Globs are anchored at the repository root and case-insensitive; `*` stays inside one directory and `**` crosses directories: `infra/**` matches everything under infra at any depth, `**/*.tf` a .tf file anywhere, while `*.tf` matches only a root file and a bare `infra` only a file of that name. A leading ./, / or !, a backslash and a trailing / can never match and are refused. A path that cannot be checked (too long to match, or a list the evaluation cut or never recorded) counts as a match. A repository override can only add globs: the union applies, so a repository cannot remove one.',
    group: 'prEvaluation',
    label: 'Routing: paths that always ask for a person',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: reviewRoutingPathsSchema,
  }),
  'prEvaluation.humanSkipsBotApproved': defineSetting({
    defaultValue: true,
    description:
      'Review routing: on, a pull request the approver App approved, with auto-merge armed, asks for no person unless the risk, size or path rule fires. Off, such a pull request still asks for a person. With the lowest-risk setting at LOW the risk rule fires on every pull request, so this only takes effect with it at STANDARD or HIGH. A repository override can only turn it off: it stays on only when both leave it on.',
    group: 'prEvaluation',
    label: 'Routing: skip bot-approved pull requests',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'prEvaluation.lowApprovers': defineSetting({
    defaultValue: 1,
    description: 'Approving reviews required on a pull request classed low risk.',
    group: 'prEvaluation',
    label: 'Approvers for low-risk pull requests',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10),
    unit: 'approvers',
  }),
  'prEvaluation.maxLowDirs': defineSetting({
    defaultValue: 5,
    description:
      'Distinct directories (top two path levels) a pull request may touch and still be classed low risk.',
    group: 'prEvaluation',
    label: 'Most directories for low risk',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(1000),
    unit: 'directories',
  }),
  'prEvaluation.maxLowFiles': defineSetting({
    defaultValue: 15,
    description: 'Files a pull request may change and still be classed low risk.',
    group: 'prEvaluation',
    label: 'Most files for low risk',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10000),
    unit: 'files',
  }),
  'prEvaluation.maxLowLines': defineSetting({
    defaultValue: 400,
    description: 'Changed lines a pull request may carry and still be classed low risk.',
    group: 'prEvaluation',
    label: 'Most changed lines for low risk',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(1000000),
    unit: 'lines',
  }),
  'prEvaluation.postReviewFindings': defineSetting({
    defaultValue: false,
    description:
      "Whether the evaluation also posts the review network's findings that fall inside the diff as inline comments, in one review that never approves or requests changes. Off, the findings appear in the brief only.",
    group: 'prEvaluation',
    label: 'Post review findings inline',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'prEvaluation.quickReviewMaxLines': defineSetting({
    defaultValue: 100,
    description:
      'Review routing: a low-risk change of at most this many changed lines is a quick review, batched with its peers and listed smallest first. A repository override can only lower it: the lower value applies.',
    group: 'prEvaluation',
    label: 'Routing: quick-review size',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: reviewRoutingLineCount,
    unit: 'lines',
  }),
  'prEvaluation.requiredStatusContext': defineSetting({
    defaultValue: 'auto-swe/pr-evaluation',
    description:
      'The commit status context the evaluation posts. Mark this context required in the repository branch protection for the approver count to be enforced.',
    group: 'prEvaluation',
    label: 'Commit status context',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: prEvaluationStatusContext,
  }),
  'prEvaluation.sensitivePaths': defineSetting({
    defaultValue: [],
    description:
      'Globs, added to the built-in list, of paths whose change always classes a pull request high risk and never allows auto-merge. Matched case-insensitively on the repository-relative path.',
    group: 'prEvaluation',
    label: 'Extra sensitive path globs',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: prEvaluationSensitivePaths,
  }),
  'prEvaluation.standardApprovers': defineSetting({
    defaultValue: 1,
    description: 'Approving reviews required on a pull request classed standard risk.',
    group: 'prEvaluation',
    label: 'Approvers for standard-risk pull requests',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10),
    unit: 'approvers',
  }),

  // ── Qodo ───────────────────────────────────────────────────────────────────
  'qodo.enabled': defineSetting({
    defaultValue: false,
    description:
      "Whether runs may read Qodo's review of pull requests. When on, PR identifiers and the team's Qodo credential are used to read Qodo's review of pull requests; no source code is uploaded by auto-swe. Off, no Qodo call is made.",
    group: 'qodo',
    label: 'Read Qodo reviews',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'qodo.prFeedbackBotAccountIds': defineSetting({
    defaultValue: [],
    description:
      "Numeric GitHub account ids of Qodo's review bot on this deployment's GitHub host (the `id` of the bot account, not its login: logins can be renamed, ids cannot). A pull-request feedback automation that lists the `qodo_findings` trigger treats a review or comment from one of these bot accounts as a nudge to read Qodo's findings. The bot's text is never read from GitHub. Empty keeps the feature inert. Platform-wide: it names who Qodo's bot is on this host.",
    group: 'qodo',
    label: 'Qodo review bot account ids',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z
      .array(
        z.preprocess(
          (v) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v),
          z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
        )
      )
      .max(10),
  }),
  'qodo.prFeedbackIncludeOnCommand': defineSetting({
    defaultValue: false,
    description:
      "When on, an `/auto-swe fix` round on a pull request the platform opened also reads Qodo's review once, without waiting, and addresses its open findings at or above `qodo.prFeedbackMinActionLevel`. Needs `qodo.enabled`.",
    group: 'qodo',
    label: 'Include Qodo findings in an /auto-swe fix round',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'qodo.prFeedbackMaxRounds': defineSetting({
    defaultValue: 2,
    description:
      "How many pushed rounds Qodo's findings may cause on one pull request, on top of the automation's own rounds limit. A round that pushes nothing does not count.",
    group: 'qodo',
    label: 'Qodo-triggered rounds per pull request',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(1).max(10),
  }),
  'qodo.prFeedbackMinActionLevel': defineSetting({
    defaultValue: 'remediation_recommended' as QodoActionLevel,
    description:
      'The lowest action level of a Qodo finding that is addressed: `action_required`, `remediation_recommended` or `informational`. Findings below it are left alone.',
    group: 'qodo',
    label: 'Lowest Qodo finding level to address',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: qodoActionLevel,
  }),
  'qodo.prFeedbackRunWaitSeconds': defineSetting({
    defaultValue: 900,
    description:
      'How long a Qodo-triggered round waits for the run that opened the pull request to finish its CI wait and park, before it gives up without changing anything. 0 skips at once, as when the run is still working.',
    group: 'qodo',
    label: 'Wait for the opening run to finish',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(900),
    unit: 'seconds',
  }),
  'qodo.prFeedbackWaitSeconds': defineSetting({
    defaultValue: 120,
    description:
      "How long a Qodo-triggered round waits for Qodo to finish reviewing the pull request's current head commit before it gives up without changing anything. 0 reads once.",
    group: 'qodo',
    label: 'Wait for Qodo to finish reviewing',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(600),
    unit: 'seconds',
  }),
  'qodo.reviewWaitSeconds': defineSetting({
    defaultValue: 180,
    description:
      "How long a workflow's Qodo review step waits for Qodo to finish reviewing the pull request's head commit when the node sets no wait of its own. 0 reads once. A node's own `waitSeconds` overrides it, and both are capped at 600.",
    group: 'qodo',
    label: 'Wait for the Qodo review step',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(600),
    unit: 'seconds',
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
  'review.enabled': defineSetting({
    defaultValue: true,
    description: 'Allow on-demand and automatically attached code reviews of finished runs.',
    group: 'review',
    label: 'Enable code reviews',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),

  // ── Skills ─────────────────────────────────────────────────────────────────
  'skills.import.blockOnScanWarnings': defineSetting({
    defaultValue: true,
    description:
      'Whether importing skills from an external source refuses a skill whose text or description draws any scanner warning, an incomplete scan included. On, the import response names the refused skills and why, and an admin installs only the rest. Off, such a skill is installed (unverified) with its warnings recorded on its first revision. A skill imported from a repository you do not control is the case this exists for: the scan is advisory everywhere else, but here the text was written by someone else.',
    group: 'skills',
    label: 'Block external skill imports with scan warnings',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),

  'skills.import.privateNetworkHosts': defineSetting({
    defaultValue: [],
    description:
      "Hosts a skill source may live on even though the host is, or resolves to, a private-network address (comma-separated host or host:port). A host is allowed only if it is ALSO an approved repository host (the GitHub integration's hosts or github.repositoryHosts); listing it here alone does nothing. Cloud metadata addresses (169.254.0.0/16, fd00:ec2::254, 100.100.100.200) and loopback stay refused whatever is listed. The text-level address check does not resolve DNS, so a listed name is trusted to mean the server you intend.",
    group: 'skills',
    label: 'Private-network skill source hosts',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: hostList,
    sensitive: true,
  }),

  // ── UI validation evidence ─────────────────────────────────────────────────
  'uiValidation.agentRecordVideo': defineSetting({
    defaultValue: true,
    description: 'Whether browser evidence recordings include video.',
    group: 'uiValidation',
    label: 'Record browser video',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'uiValidation.agentScreenshotImages': defineSetting({
    defaultValue: true,
    description:
      'Whether the agent browser tool returns screenshot images to the model; turn off for models without image input.',
    group: 'uiValidation',
    label: "Send screenshots to the agent's model",
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'uiValidation.evidenceRetentionDays': defineSetting({
    defaultValue: 90,
    description: 'How long run UI evidence is kept before the daily retention sweep deletes it.',
    group: 'uiValidation',
    label: 'UI evidence retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(1).max(3650),
    unit: 'days',
  }),
  'uiValidation.maxEvidencePerRun': defineSetting({
    defaultValue: 200,
    description: 'Maximum number of UI evidence items one workflow run may record.',
    group: 'uiValidation',
    label: 'Maximum UI evidence items per run',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(10_000),
    unit: 'items',
  }),
  'uiValidation.maxScreenshotBytes': defineSetting({
    defaultValue: 5_000_000,
    description: 'Maximum size of a screenshot evidence item.',
    group: 'uiValidation',
    label: 'Maximum screenshot size',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(100_000_000),
    unit: 'bytes',
  }),
  'uiValidation.maxVideoBytes': defineSetting({
    defaultValue: 50_000_000,
    description: 'Maximum size of a video evidence item.',
    group: 'uiValidation',
    label: 'Maximum video size',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(1_000_000_000),
    unit: 'bytes',
  }),
  'uiValidation.prInlineImages': defineSetting({
    defaultValue: false,
    description:
      'Whether UI evidence screenshots may be copied to a public bucket for pull requests.',
    group: 'uiValidation',
    label: 'Inline UI screenshots in pull requests',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),

  // ── Personal desk ──────────────────────────────────────────────────────────
  // Read per request by `GET /api/v1/me/summary`, which has no team: GLOBAL only.
  'workflow.approvalDueSoonHours': defineSetting({
    defaultValue: 24,
    description:
      "How close to its deadline a pending approval must be to count as due soon on a person's desk, where it is listed ahead of the rest. An approval with no deadline is never due soon.",
    group: 'workflow',
    label: 'Approval due-soon window',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(1).max(720),
    unit: 'hours',
  }),

  // ── Automation ledger ──────────────────────────────────────────────────────
  // Read by the daily ledger sweep, which has no team: GLOBAL only.
  'workflow.automationDecisionRetentionDays': defineSetting({
    defaultValue: 90,
    description:
      "How long an event automation's decisions that started no run (suppressed, failed to start) are kept before the daily sweep deletes them. Decisions that started a run are kept regardless: the same-commit and own-fix guards read them. At least 7 days, so a host's redelivery of a recent webhook still finds its decision.",
    group: 'workflow',
    label: 'Automation decision retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(7).max(3650),
    unit: 'days',
  }),

  // ── Run callbacks ──────────────────────────────────────────────────────────
  // Read by the daily outbox sweep, which has no team: GLOBAL only.
  'workflow.callbackDeliveryRetentionDays': defineSetting({
    defaultValue: 30,
    description:
      'How long delivered and dead run-callback deliveries are kept, with their status codes and error classes, before the daily sweep deletes them. Pending deliveries are never deleted. A delivery older than this can no longer be redelivered from its history.',
    group: 'workflow',
    label: 'Run callback delivery retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(1).max(3650),
    unit: 'days',
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
  'workflow.httpCaptureBodyMaxBytes': defineSetting({
    defaultValue: 8192,
    description: 'Maximum redacted bytes per non-model HTTP body; zero disables body storage.',
    group: 'workflow',
    label: 'HTTP body capture limit',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(65536),
  }),
  'workflow.httpCaptureEnabled': defineSetting({
    defaultValue: true,
    description: 'Whether activity HTTP exchanges are recorded.',
    group: 'workflow',
    label: 'HTTP capture enabled',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'workflow.httpCaptureRetentionDays': defineSetting({
    defaultValue: 90,
    description: 'Days HTTP exchanges are retained before the daily sweep deletes them.',
    group: 'workflow',
    label: 'HTTP capture retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(1).max(3650),
  }),
  // ── Inbound events ─────────────────────────────────────────────────────────
  // Read per event by the event-endpoint receiver and the engine, with the endpoint's team.
  'workflow.inboundEventsEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether events posted to a team's event endpoints may start runs. Off by default: an event's content is the sender's text, so an admin turns this on deliberately, per team or organization. While off, an endpoint refuses every call with 409 after checking its signature, and nothing is recorded. Turning it off does not stop runs already started.",
    group: 'workflow',
    label: 'Inbound event automations enabled',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  // ── Jira filter polling ────────────────────────────────────────────────────
  // Read each tick by the gateway's poller (the interval) and per automation (the other two),
  // with the repository's team.
  'workflow.jiraPollAutomationsEnabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a repository's Jira filter automations may poll Jira and start runs. Off by default: a new issue in a filter starts a template on the issue's text, which anyone with access to the Jira project may have written, so an admin turns this on deliberately, per team or organization. While off, no Jira request is made for the team's automations. Turning it off does not stop runs already started.",
    group: 'workflow',
    label: 'Jira filter automations enabled',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'workflow.jiraPollIntervalSeconds': defineSetting({
    defaultValue: 300,
    description:
      'Seconds between polls of every Jira filter automation. One value for the whole deployment, read before each poll, so a change applies from the next one.',
    group: 'workflow',
    label: 'Jira poll interval',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(60).max(86_400),
    unit: 'seconds',
  }),
  'workflow.jiraPollProjectKeys': defineSetting({
    defaultValue: [],
    description:
      'Jira project keys a Jira filter automation may act on. The platform queries Jira with its own credential, so a filter can see every project that credential can; only issues in these projects are acted on, whatever the filter says. Empty means no issue is acted on, and a Jira filter automation cannot be saved.',
    group: 'workflow',
    label: 'Jira projects allowed for filter automations',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{1,49}$/)).max(100),
  }),
  'workflow.maxNeedsInputRounds': defineSetting({
    defaultValue: 5,
    description:
      'Most times one agent step may stop to ask a person a question and be resumed. A step that asks again after the last allowed round fails with NEEDS_INPUT_LIMIT instead of waiting on a person indefinitely.',
    group: 'workflow',
    label: 'Max needs-input rounds per step',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: true,
    schema: z.number().int().min(1).max(20),
    unit: 'rounds',
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
  'workflow.needsInputTimeoutSeconds': defineSetting({
    defaultValue: 86_400,
    description:
      "How long an agent step that stopped to ask a person a question waits for the answer. When it passes the step fails with NEEDS_INPUT_TIMEOUT; nothing answers on the person's behalf.",
    group: 'workflow',
    label: 'Needs-input answer timeout',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: true,
    schema: z.number().int().min(60).max(1_209_600),
    unit: 'seconds',
  }),
  'workflow.prTitleFormat': defineSetting({
    defaultValue: 'template',
    description:
      "How the title of a pull request the platform opens is written. 'template' renders the PR title template; 'conventional' writes a Conventional Commits title (`type: summary`, at most 72 characters), the type taken from 'PR title type' or, when that is auto, chosen by the prTitler agent from the request and the files changed. A repository's own setting wins over this one.",
    group: 'workflow',
    label: 'PR title format',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.enum(PR_TITLE_FORMATS),
  }),
  'workflow.prTitleTemplate': defineSetting({
    defaultValue: '',
    description:
      "The title template for 'template' format, with {{ticketId}} and {{description}} placeholders. Empty means the template set at Workflow defaults. A repository's own template wins over this one. Agent runs use a template only when this or the repository sets one.",
    group: 'workflow',
    label: 'PR title template',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.string().trim().max(300),
  }),
  'workflow.prTitleType': defineSetting({
    defaultValue: 'auto',
    description:
      "The Conventional Commits type every pull request title carries in 'conventional' format. Auto lets the prTitler agent choose per pull request; a fixed type skips that model call, which suits a template that always does one kind of work (a docs refresh is always docs).",
    group: 'workflow',
    label: 'PR title type',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.enum(['auto', ...CONVENTIONAL_COMMIT_TYPES]),
  }),

  // ── Runless workflows ──────────────────────────────────────────────────────
  // Workflow authoring and explaining, scheduled evals, lesson consolidation and
  // dependency inference keep no run, so no budget tier applies to them. These
  // cap one execution's spend instead, summed from its trace rows. Not
  // run-pinned: there is no run to pin to. They resolve against the team or
  // organization the execution's spend is attributed to.
  'workflow.runlessMaxInputTokens': defineSetting({
    defaultValue: 20_000_000,
    description:
      'Most input tokens one execution of a workflow that keeps no run may spend — workflow authoring and explaining, scheduled evals, lesson consolidation, dependency inference. The execution fails with BUDGET_EXCEEDED once it passes the cap. An eval dataset run multiplies the cap by its case count, and one that runs out part-way finishes with a partial verdict over the cases that completed.',
    group: 'workflow',
    label: 'Runless workflow: max input tokens',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt,
    unit: 'tokens',
  }),
  'workflow.runlessMaxOutputTokens': defineSetting({
    defaultValue: 5_000_000,
    description:
      'Most output tokens one execution of a workflow that keeps no run may spend. See the input-token cap.',
    group: 'workflow',
    label: 'Runless workflow: max output tokens',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt,
    unit: 'tokens',
  }),

  // ── Template webhooks ──────────────────────────────────────────────────────
  // Read per call by the public trigger with the template's team and organization.
  'workflow.templateWebhookRequireSignature': defineSetting({
    defaultValue: false,
    description:
      "Whether every template webhook in scope must be called with a valid X-AutoSwe-Signature, in addition to templates whose own require-signature switch is on. Resolved for the template's team, most specific scope first, so a team override of off exempts that team from an organization-wide on. An unsigned or badly signed call is refused with 401, and a template with no signing secret refuses every call until one is generated. A global template is covered only by the platform-wide value.",
    group: 'workflow',
    label: 'Template webhooks must be signed',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),

  // Read by `validateContext` and `executeImplementation` when no step handed them a ticket.
  'workflow.ticketContextFallback': defineSetting({
    defaultValue: false,
    description:
      "Whether the validate and implement steps fetch the run's tracker ticket themselves when the workflow has no 'Gather ticket context' step. Off by default: a workflow that wants the ticket says so with that step, which is visible, costs a model call only where it is placed, and shows in the run's graph. Turn this on to give older templates the ticket without editing them; the ticket is then read with the platform's tracker token, as the step does. The step also reads, for Jira, the parent issue and the newest comments; this fallback reads the ticket's own fields only.",
    group: 'workflow',
    label: 'Fetch the tracker ticket when no step did',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  // ── Agent transcripts ─────────────────────────────────────────────────────
  // Read by the worker's activity interceptor and the daily retention sweep,
  // both of which have no team: GLOBAL only.
  'workflow.transcriptAccessLogRetentionDays': defineSetting({
    defaultValue: 2555,
    description:
      'How long the transcript access audit log (content reads, download links, exports, verifications, legal-hold changes and refused attempts) is kept before the daily transcript sweep deletes it. Independent of transcript retention: an access row outlives the transcript it names.',
    group: 'workflow',
    label: 'Transcript access log retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(365).max(3650),
    unit: 'days',
  }),
  'workflow.transcriptCaptureEnabled': defineSetting({
    defaultValue: true,
    description:
      'Whether every activity attempt records its model traffic (request and response bodies, secrets redacted) as an agent transcript kept until retention expires. Off turns recording into a no-op without restarting the worker; transcripts already stored are kept and still swept by retention.',
    group: 'workflow',
    label: 'Agent transcript capture enabled',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'workflow.transcriptMaxBytes': defineSetting({
    defaultValue: 67_108_864,
    description:
      'Largest one transcript may grow, in compressed bytes summed over its parts. A transcript that passes the cap gets a truncated marker, stops recording, and closes as truncated.',
    group: 'workflow',
    label: 'Max bytes per agent transcript',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(1_048_576).max(1_073_741_824),
    unit: 'bytes',
  }),
  'workflow.transcriptRetentionDays': defineSetting({
    defaultValue: 365,
    description:
      'How long agent transcripts and their parts are kept before the daily sweep deletes them. Transcripts under a legal hold are never deleted; a transcript outlives the run it belongs to (run deletion clears only its link, not the transcript).',
    group: 'workflow',
    label: 'Agent transcript retention',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(1).max(3650),
    unit: 'days',
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

  // Pinned: a run's containers must not change network posture mid-run, and a retry or replay
  // must take the same path. A launcher may narrow it for one run (never widen); see
  // `narrowEgressPolicy`.
  'workspace.egressPolicy': defineSetting({
    defaultValue: 'open' as EgressPolicy,
    description:
      "How much outbound network access a run's containers get. `open` applies the team egress allowlist when one exists and permits any public host otherwise. `restricted` makes the team allowlist mandatory, so an empty allowlist leaves only what `blocked` allows. `blocked` leaves only the platform's own proxies and the repository's git host reachable. A run's launcher may choose a stricter level for that run but never a looser one. `restricted` is enforced by the egress proxy and by a network-level lock of the workspace to the proxies and the git host. `blocked` leaves only the model and registry proxies and the git host reachable. On Kubernetes, DNS to the cluster DNS service stays reachable, which is a low-bandwidth channel. The policy governs the workspace's own traffic only: MCP and worker-side connectors originate from the worker and are not affected.",
    group: 'workspace',
    label: 'Run egress policy',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: true,
    schema: egressPolicySchema,
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
  'workspace.harnessApiRetries': defineSetting({
    defaultValue: 4,
    description:
      "How many times the Claude Code harness retries a failed model API call before it gives up, with the harness's exponential backoff between tries. The harness's own default is 10, which holds a turn for about three minutes when the API keeps refusing it (a rejected key is retried like any other error); 4 gives up after about 20 seconds of backoff, which still absorbs a brief overload without losing the conversation in progress. A turn that gives up fails and the activity's own retry policy decides what happens next, from a fresh workspace. Applies to the Claude Code runtime; the Mastra loop and Pi make their own retries.",
    group: 'workspace',
    label: 'Harness API retries',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(10),
    unit: 'retries',
  }),
  'workspace.harnessContextTokens': defineSetting({
    defaultValue: 120_000,
    description:
      "Token budget for the conversation a harness carries from one turn to the next, estimated at three characters per token and counted with the system prompt and tool definitions. Applies to the Pi runtime. Before each model call over the budget, old tool output and old file content in write/edit calls are replaced with short stubs, then the oldest whole exchanges (a prompt and the work that answered it) are dropped, then the current exchange is stubbed oldest first; the current prompt is always sent. Set it below the model's context window, leaving room for its reply. The Mastra loop starts each turn afresh and does not read it.",
    group: 'workspace',
    label: 'Harness context budget',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'LEAD',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.min(1_000).max(2_000_000),
    unit: 'tokens',
  }),
  // Pinned because the runtime decides who executes the tool loop and which
  // credential enters the workspace: a run that began on one runtime must not
  // finish a later iteration on the other, and a re-run of the same history
  // must take the same path.
  'workspace.implementerRuntime': defineSetting({
    defaultValue: 'mastra',
    description:
      "The default loop that drives the implementer, the CI/review/gate fixers and the merge-conflict resolver; an Agent version that sets its own runtime wins over it. `mastra` runs the platform's own tool loop. `claude-code` runs the Claude Code harness inside the workspace container: it reads the repository's own CLAUDE.md and .claude settings, but the worker allows only its Read, Write, Edit, Bash, Glob and Grep tools, narrowed by the agent's tool keys and behind the same security scanners, and refuses every other tool, including web access, sub-agents and plugin tools. The harness needs a model API key (or a gateway key) inside the container, where anything the agent runs can read it; see the Limitations in docs/agents.md before enabling it. `pi` runs Pi's agent loop in the worker: Pi's read, write, edit, ls, grep and find tools and a shell act on the container behind the same scanners, the agent's MCP connection is relayed from the worker, and its model calls and credential stay in the worker.",
    group: 'workspace',
    label: 'Implementer runtime',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: true,
    schema: z.enum(IMPLEMENTER_RUNTIMES),
  }),

  // ── Agent workspace ────────────────────────────────────────────────────────
  // Tunes the implementer's tool behaviour rather than the container itself,
  // but there is no `implementer` group (only channel/memory/workflow/workspace
  // exist), and every key must share its group's prefix (see the
  // `SETTING_DEFINITIONS` integrity test), so it's named and grouped here.
  'workspace.lfsStorageHosts': defineSetting({
    defaultValue: [
      'github.com=github-cloud.githubusercontent.com',
      'github.com=media.githubusercontent.com',
    ],
    description:
      "Hosts a git host serves Git LFS files from, as `git-host=storage-host` entries (comma-separated; one entry per storage host, host or host:port). Under the `blocked` and `restricted` egress policies, a workspace whose setup sets `lfs: true` may also reach the storage hosts listed for its repository's git host. An LFS server that serves files from its own host needs no entry.",
    group: 'workspace',
    label: 'Git LFS storage hosts',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z
      .array(
        z
          .string()
          .regex(/^[^=]+=[^=]+$/, 'must be git-host=storage-host')
          .superRefine((entry, ctx) => {
            for (const host of entry.split('=')) {
              const parsed = hostEntry.safeParse(host);
              if (!parsed.success) {
                ctx.addIssue({
                  code: 'custom',
                  message: `${host}: ${parsed.error.issues[0]?.message ?? 'invalid host'}`,
                });
              }
            }
          })
      )
      .max(50),
    sensitive: true,
  }),
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
  'workspace.nulAllowedPaths': defineSetting({
    defaultValue: [],
    description:
      'Globs of paths that may hold a NUL byte although their name does not say binary. A file the security gate reads is refused (a CRITICAL hidden-content finding, which fails the step) when it adds a NUL byte and is neither named like a binary, UTF-16 text, nor an executable or archive by its first bytes, because a NUL changes how tools read a file and can hide lines from a reviewer. A file that matches one of these globs is reduced to its printable strings like a binary instead: the gate no longer reads its lines, so list only a path whose content you accept unread (a test fixture directory such as `test/fixtures/**`, a vendored blob with an unusual name). UTF-16 text needs no entry; the repository-side alternative is `working-tree-encoding=UTF-8` in `.gitattributes`. Globs are anchored at the repository root and case-insensitive; `*` stays inside one directory and `**` crosses directories. A leading ./, / or !, a backslash and a trailing / can never match and are refused. Platform-wide: it cannot be overridden for a team, organization or workflow template.',
    group: 'workspace',
    label: 'Paths allowed to hold a NUL byte',
    overridableAt: [],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: reviewRoutingPathsSchema,
  }),
  'workspace.repoSetupStackDefaults': defineSetting({
    defaultValue: false,
    description:
      'Whether a repository with no setup of its own (no repository setup and no `.auto-swe/setup.yml`) gets one from its detected stack, for a root or single component whose directory holds the file its install needs: Node through its lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable` or `--frozen-lockfile`), Python through `uv.lock` (`uv sync --frozen`) or `requirements.txt` (into a `.venv`), Go through `go.sum` (`go mod download`), Maven (`mvn dependency:go-offline`) and Gradle through `gradlew`, each cached by its lockfile or build files. Anything else gets none. A failing install fails the workspace, as configured setup does.',
    group: 'workspace',
    label: 'Stack-default repository setup',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'workspace.setupCacheMaxMb': defineSetting({
    defaultValue: 1024,
    description:
      'Largest compressed dependency cache a workspace saves after its setup steps. A larger archive is not saved, and the next workspace runs its setup without one. `0` turns the cache off. The cache needs the S3 or filesystem artifact backend; on the Postgres backend nothing is cached.',
    group: 'workspace',
    label: 'Setup cache size limit',
    overridableAt: ['ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.number().int().min(0).max(8192),
    unit: 'MB',
  }),

  'workspace.setupEgressPolicy': defineSetting({
    defaultValue: 'inherit' as SetupEgressPolicy,
    description:
      'Network policy for agent-workspace setup. `inherit` preserves the run egress policy and existing setup order. `open` gives setup the baseline only; `restricted` permits the team allowlist through the egress proxy. A stricter or equal setup policy is ignored. Before agent execution, setup processes are terminated and verified gone, then the run egress lock replaces the setup lock. Attached services remain running in separate containers. Repository-controlled setup can access its declared secrets and workspace proxy credentials under this policy. This is a pinned cascade setting, not a launcher override; shell/containerStep steps are unaffected.',
    group: 'workspace',
    label: 'Setup egress policy',
    overridableAt: ['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: true,
    schema: setupEgressPolicySchema,
  }),
  'workspace.toolInstall.agentCallable': defineSetting({
    defaultValue: false,
    description:
      'Whether an agent whose tool list names `provisionTool` may install a catalog tool mid-run. The agent still chooses only among catalog entries the connection allows; this switch decides whether the tool does anything.',
    group: 'workspace',
    label: 'Let agents install catalog tools',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'workspace.toolInstall.enabled': defineSetting({
    defaultValue: false,
    description:
      "Whether a workspace installs tools from the tool catalog before the run starts: the connection's admin tool list always, and its `.auto-swe/tools.yml` when that connection also enables the file. Off, no tool is installed whatever a repository declares.",
    group: 'workspace',
    label: 'Install catalog tools on demand',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: z.boolean(),
  }),
  'workspace.toolInstall.maxTools': defineSetting({
    defaultValue: 8,
    description:
      "The most tools one run may install, from the file, the connection's list and the agent together. A run that asks for more fails at setup instead of being truncated.",
    group: 'workspace',
    label: 'Max tools per run',
    overridableAt: ['TEAM', 'ORGANIZATION'],
    requiredRole: 'ADMIN',
    restartRequired: false,
    runPinned: false,
    schema: positiveInt.max(32),
    unit: 'tools',
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
