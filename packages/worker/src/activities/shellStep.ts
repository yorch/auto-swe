/**
 * Phase-6 shell-step activity.
 *
 * Runs a user-authored command inside a locked-down ephemeral container
 * (see packages/worker/src/lib/ephemeralContainer.ts) with the work-request's
 * branch checked out into a fresh Docker volume that's bind-mounted at
 * `/workspace`. After the command exits, any uncommitted changes in the
 * volume are auto-committed and pushed so downstream agents/gates see the
 * effect.
 *
 * Threat-model recap (vs. the agent workspace):
 *   - Image must be on the team's allowlist (built-in defaults + Team additions).
 *     Rejected at workflow start.
 *   - No Docker socket mount, no privileges, CPU/memory/PID caps, --read-only
 *     root filesystem, /tmp on a small tmpfs.
 *   - `--network=none` by default. Authors opt in to outbound via `network: 'egress'`.
 *   - No SCM credential at rest in the workspace volume: `origin` is scrubbed
 *     immediately after clone and the finalize push authenticates per-call via
 *     `http.extraheader`. An author command therefore cannot read the token,
 *     and equally cannot run its own authenticated `git fetch`/`push` — see
 *     `cloneIntoVolume`.
 *
 * Return shape mirrors the phase-2 GateResult so the interpreter's
 * gate-failure path (`passed === false` → onFail policy) fires uniformly for
 * both quality gates and shell steps.
 */

import crypto from 'node:crypto';
import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { putArtifact } from '@auto-swe/shared/lib/artifactStore';
import { DOCKER_HOST_ALIAS, resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { assertShellImageAllowed, ShellImageNotAllowedError } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { currentWorkflowId, currentWorkflowRunId } from '../lib/activityContext.js';
import { logWarn } from '../lib/activityLog.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import {
  maskCredentialShapes,
  redactExecError,
  redactSecrets,
  redactToken,
} from '../lib/redactToken.js';
import { workerRegistryProxy } from '../lib/registryProxy/index.js';
import { renderNpmrc, renderYarnrc } from '../lib/registryProxy/render.js';
import {
  beginWorkspaceRegistries,
  buildRegistryAllowlist,
  type WorkspaceRegistryAccess,
} from '../lib/registryProxy/workspaceWiring.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { resolveRequestBaseBranch } from '../lib/runBaseBranch.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { workspaceBackend } from '../lib/workspaceBackend/index.js';
import { recordLessonBackground } from './commitToMemory.js';
import { truncate } from './qualityGates.js';
import {
  gitWithAuthHeader,
  sanitizeGitRepoConfigScript,
  shellQuote,
  splitCloneCredential,
} from './workspace.js';

export interface ShellStepInput {
  request: RepoWorkRequest;
  /** Docker image (must be on allowlist; validated at runtime too). */
  image: string;
  /** Shell command. Required. */
  command: string;
  network?: 'none' | 'egress';
  memory?: string;
  cpus?: number;
  timeoutMs?: number;
  /** Override the branch checked out into the workspace. Defaults to the work-request branch. */
  branch?: string;
}

export interface ShellStepResult {
  /**
   * Whether the step achieved its outcome: the command exited 0 AND, when it
   * changed files, those changes reached the branch. A push that failed leaves
   * the changes only in the discarded volume, so the run must not report the
   * step as green — the same reasoning that makes a gate refuse to run against
   * the wrong tree rather than pass. A spec that wants the command's own exit
   * code to be the only verdict, or that is not trying to land a change, says so
   * with `onFail: 'warn'`.
   */
  passed: boolean;
  summary: string;
  exitCode: number;
  signal?: string;
  artifactId?: string;
  /** SHA of the auto-commit, if any changes were made. */
  committedSha?: string;
  /**
   * False when the command succeeded but the workspace could not be finalized —
   * the auto-commit/push did not complete, or a later step of the finalize
   * failed, so the change could not be confirmed on the branch. Distinguished
   * from a command failure by `exitCode` and this field; both make `passed`
   * false. Read as "not confirmed persisted", not "the push failed": the
   * finalize runs in one script, and which of its commands failed is not
   * reported.
   */
  persisted: boolean;
  /** Files touched relative to the prior HEAD. Empty when the command made no changes. */
  filesChanged: string[];
}

// Tiny (~5MB) helper image with git built-in, used by the prep + finalize
// phases. A registry setting rather than a constant so a deployment can pin a
// digest instead of tracking the upstream `latest` tag.
//
// Resolved ONCE at the top of the step and threaded down, deliberately: the
// finalize path's errors are swallowed and reported as "command passed but the
// push failed", so a config-resolution failure in there would surface as a
// successful step whose changes were silently never committed.
async function gitHelperImage(): Promise<string> {
  return resolveSetting('workspace.gitHelperImage', await currentRequestContext());
}

/**
 * Run one trusted git-helper container (`docker run --rm -v vol:/workspace:rw
 * --entrypoint sh <helper-image> -c <script>`) through the workspace backend
 * and resolve to stdout, throwing with the captured output on a non-zero exit.
 */
async function runHelper(
  script: string,
  volumeName: string,
  image: string,
  tokenForRedact?: string | null,
  maxOutputBytes?: number
): Promise<string> {
  const backend = workspaceBackend();
  try {
    const res = await backend.runHelper(
      {
        argv: ['-c', script],
        entrypoint: 'sh',
        image,
        volumes: [{ source: volumeName, target: '/workspace' }],
      },
      { heartbeatLabel: 'shell-step: helper', ...(maxOutputBytes ? { maxOutputBytes } : {}) }
    );
    if (res.exitCode !== 0) {
      const err = new Error(
        `helper exited ${res.exitCode}: ${(res.stderr ?? res.stdout ?? '').slice(0, 500)}`
      ) as Error & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = res.stdout;
      err.stderr = res.stderr;
      throw err;
    }
    return res.stdout;
  } catch (err) {
    // The clone runs with the token embedded in the URL (see `loadRepoMeta`),
    // so a failure could leak it into Temporal history without this.
    redactExecError(err, [tokenForRedact]);
    throw err;
  }
}

interface RepoMeta {
  /** Credential-embedded clone URL from ScmProvider.cloneCredentials. */
  cloneUrl: string;
  /**
   * `cloneUrl` with the credential stripped — what `origin` is reset to right
   * after clone, so the token never sits at rest in the workspace volume the
   * author-supplied command can read.
   */
  cleanUrl: string;
  /**
   * `AUTHORIZATION: basic …` header used to authenticate the finalize push via
   * `git -c http.extraheader`, instead of a credential-bearing `origin`.
   * Undefined when the provider handed back an unauthenticated URL.
   */
  gitAuthHeader?: string;
  defaultBranch: string;
  teamId: string;
  teamAllowlist: string[];
  teamEgressAllowlist: string[];
  /** The resolved token — kept alongside cloneUrl so error-path redaction works
   * even when no GITHUB_TOKEN env var is set (DB-only token configuration). */
  token: string;
}

async function loadRepoMeta(request: RepoWorkRequest): Promise<RepoMeta> {
  const repo = await prisma.connection.findUniqueOrThrow({
    include: {
      installation: { select: { host: true, installationId: true } },
      team: { select: { egressAllowlist: true, id: true, shellImageAllowlist: true } },
    },
    where: { id: requireRepoId(request, 'shell') },
  });
  const repoRef = toRepoRef(repo);
  const { authedCloneUrl, token } = await getScmProvider(repoRef).cloneCredentials(repoRef);
  // Shared with the agent workspace (`activities/workspace.ts`): split the
  // credential out of the clone URL so it can be injected per network call
  // rather than persisted in `.git/config`.
  const { cleanUrl, gitAuthHeader } = splitCloneCredential(authedCloneUrl);
  return {
    cleanUrl,
    cloneUrl: authedCloneUrl,
    // The run's base: what a step that runs before the first push falls back to cloning.
    defaultBranch: await resolveRequestBaseBranch(request, repo),
    ...(gitAuthHeader ? { gitAuthHeader } : {}),
    teamAllowlist: (repo.team?.shellImageAllowlist as string[] | null) ?? [],
    teamEgressAllowlist: (repo.team?.egressAllowlist as string[] | null) ?? [],
    teamId: repo.team?.id ?? '',
    token,
  };
}

/**
 * Clone the branch into the given volume. Falls back to the default branch
 * *only* when git reports the branch doesn't exist remotely (e.g. shell step
 * runs before the implementer's first push). Auth / network / docker
 * failures are surfaced unchanged so they're not masked by a confusing
 * default-branch retry. Caller owns volume lifecycle.
 *
 * The credential is scrubbed out of `origin` in the same `sh -c` script as the
 * clone (same approach as `createWorkspace` in `workspace.ts`): this volume is
 * bind-mounted into the container that runs the *author-supplied* command with
 * `/workspace/repo` as cwd, so a token baked into `.git/config` would be live
 * data inside the sandbox — readable with `cat .git/config` or `git remote -v`
 * and, on a `network: 'egress'` step, exfiltratable. Output redaction cannot
 * contain that: `redactToken` matches the exact substring, so any transform
 * (`base64`, `rev`, `tr`, `fold`) defeats it. Removing the credential at rest
 * is the actual fix; the redaction below it stays as defense in depth.
 *
 * DELIBERATE BEHAVIOR CHANGE: with `origin` scrubbed, an author command doing
 * its own `git fetch` / `git pull` / `git push` against a private repo now
 * fails to authenticate. That is intended — an author-supplied shell command
 * should not hold the org's push credential. The supported way to persist work
 * is to leave changes in the working tree: `finalizeWorkspaceVolume` commits
 * and pushes them, authenticating per-call via `http.extraheader`.
 */
async function cloneIntoVolume(
  volumeName: string,
  meta: RepoMeta,
  branch: string,
  image: string,
  forRegistry = false
): Promise<void> {
  // Every interpolated value stays `shellQuote`d — this string is the
  // injection boundary for the branch name and the remote URL.
  // When registry wiring applies the allowlist is built from the base branch,
  // which the shallow clone never fetched — fetch it before the origin scrub,
  // while the URL still carries the credential.
  const fetchBase = forRegistry
    ? `git fetch --depth=50 origin ${shellQuote(meta.defaultBranch)}:${shellQuote(`refs/remotes/origin/${meta.defaultBranch}`)} && `
    : '';
  const tryClone = (refspec: string): Promise<string> =>
    runHelper(
      `git clone --depth=50 -b ${shellQuote(refspec)} ${shellQuote(meta.cloneUrl)} /workspace/repo && cd /workspace/repo && ${fetchBase}git remote set-url origin ${shellQuote(meta.cleanUrl)} && git config user.name 'auto-swe' && git config user.email 'auto-swe@localhost'`,
      volumeName,
      image,
      meta.token
    );
  try {
    await tryClone(branch);
  } catch (err) {
    if (!isBranchNotFoundError(err)) {
      throw err;
    }
    await tryClone(meta.defaultBranch);
  }
}

/**
 * Recognize git's "branch doesn't exist" stderr. git uses different phrasings
 * across versions: "Remote branch X not found in upstream origin",
 * "fatal: couldn't find remote ref refs/heads/X", and "warning: Could not
 * find remote branch X to clone".
 */
function isBranchNotFoundError(err: unknown): boolean {
  const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
  const haystack = [e.stderr, e.stdout, e.message]
    .filter((s): s is string => typeof s === 'string')
    .join('\n');
  return (
    /Remote branch .* not found/i.test(haystack) ||
    /couldn't find remote ref/i.test(haystack) ||
    /Could not find remote branch/i.test(haystack)
  );
}

/**
 * The script `finalizeWorkspaceVolume` runs in its helper container.
 *
 * The author command had write access to the volume's `.git/`, so nothing in
 * it is trusted here: the config is rewritten from an allow-list BEFORE the
 * first git command, and every git command — not only the push — runs
 * hardened (hooks off, system/global config ignored). A `pre-commit` hook that
 * ran here could otherwise replace `git` in this container before the
 * credential-bearing push. The rewrite also pins `GIT_DIR` / `GIT_WORK_TREE`
 * for every command after it (see `sanitizeGitRepoConfigScript`), so a `.git`
 * the author command broke cannot send `git add` up to a parent repository
 * whose `filter.*.clean` would run in this network-enabled container. Filter,
 * diff and merge drivers all need a config entry to run, and the rewrite keeps
 * none, so an in-tree `.gitattributes` naming one is inert. Identity is passed
 * per-call because the rewrite drops the repo-local `user.*` the clone set.
 */
export function finalizeScript(
  repoDir: string,
  opts: { branch: string; commandSummary: string; cleanUrl: string; gitAuthHeader?: string }
): string {
  const git = (sub: string) => gitWithAuthHeader(sub);
  const identity = "-c user.name='auto-swe' -c user.email='auto-swe@localhost'";
  return [
    'set -e',
    `cd ${shellQuote(repoDir)}`,
    sanitizeGitRepoConfigScript(opts.cleanUrl),
    `if [ -z "$(${git('status --porcelain')})" ]; then`,
    '  echo NO_CHANGES',
    '  exit 0',
    'fi',
    git('add -A'),
    git(`${identity} commit -m ${shellQuote(`auto: shell step ${opts.commandSummary}`)}`),
    // `gitWithAuthHeader` shell-quotes the header; the branch is quoted here.
    // Pushed to the scrubbed URL explicitly, not through the `origin` name.
    gitWithAuthHeader(
      `push --no-verify ${shellQuote(opts.cleanUrl)} HEAD:${shellQuote(opts.branch)}`,
      opts.gitAuthHeader
    ),
    git('rev-parse HEAD'),
    git('diff --name-only HEAD~1 HEAD'),
  ].join('\n');
}

interface FinalizeResult {
  committedSha?: string;
  filesChanged: string[];
}

/**
 * If the shell command modified the working tree, commit and push the result
 * back to origin on the same branch. Returns the auto-commit SHA + the list
 * of changed files. Skips silently when no changes are present.
 *
 * This runs in a *separate* container from the author's command, after it has
 * exited, so it is the only place the credential is legitimately needed. It is
 * injected for the push call alone via `git -c http.extraheader` (shared with
 * the agent workspace's `gitAuthed`), because `origin` was scrubbed by
 * `cloneIntoVolume` and no longer carries it.
 */
async function finalizeWorkspaceVolume(
  volumeName: string,
  branch: string,
  commandSummary: string,
  image: string,
  token: string,
  cleanUrl: string,
  gitAuthHeader?: string
): Promise<FinalizeResult> {
  const script = finalizeScript('/workspace/repo', {
    branch,
    cleanUrl,
    commandSummary,
    gitAuthHeader,
  });
  // `git push` failures can still echo credential material (e.g. a git build
  // that logs the extraheader, or an operator-supplied URL we failed to
  // parse) — pass the token through so `runDocker`'s catch redacts it before
  // it ever reaches the caller. Defense in depth on top of the scrub.
  // `runHelper`'s catch redacts the token before a failure can reach the
  // caller — defense in depth on top of the origin scrub.
  const out = await runHelper(script, volumeName, image, token);
  if (out.includes('NO_CHANGES')) {
    return { filesChanged: [] };
  }
  const lines = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  // After our script: last 1 line is the diff list (may be empty), preceded
  // by the rev-parse HEAD line.
  const sha = lines.find((l) => /^[0-9a-f]{7,40}$/.test(l));
  const files = lines.filter((l) => !/^[0-9a-f]{7,40}$/.test(l) && l !== 'NO_CHANGES');
  return {
    filesChanged: files,
    ...(sha ? { committedSha: sha } : {}),
  };
}

/**
 * Run a phase-6 shell step. Caller (the workflow dispatcher) is expected to
 * have validated the image at template-save time, but we re-check here so a
 * stale spec / corrupted DB row can't silently bypass the allowlist.
 */
export async function runShellStep(input: ShellStepInput): Promise<ShellStepResult> {
  const meta = await loadRepoMeta(input.request);

  // Defense in depth: re-validate against the team's current allowlist.
  try {
    assertShellImageAllowed(input.image, meta.teamAllowlist);
  } catch (err) {
    if (err instanceof ShellImageNotAllowedError) {
      return {
        exitCode: 126, // POSIX "command invoked cannot execute"
        filesChanged: [],
        passed: false,
        persisted: false,
        summary: err.message,
      };
    }
    throw err;
  }

  const { branchPrefix } = await resolveWorkflowDefaults();
  const branch = input.branch ?? `${branchPrefix}/${input.request.externalTicketId}`;
  const helperImage = await gitHelperImage();

  const volumeName = `shellvol-${crypto.randomBytes(8).toString('hex')}`;
  const backend = workspaceBackend();
  await backend.createVolume(volumeName);
  // Registry wiring only when the step opted into egress: 'none' gets
  // nothing, and a proxy advertised at a host other than the Docker alias is
  // unreachable on this network — warn and run without it.
  let registry: WorkspaceRegistryAccess | null = null;
  if (input.network === 'egress' && workerRegistryProxy()) {
    const access = await beginWorkspaceRegistries(meta.teamId, volumeName);
    if (access) {
      if (new URL(access.baseUrl).hostname !== DOCKER_HOST_ALIAS) {
        logWarn('registry proxy is not on the docker host alias; skipping registry wiring', {
          baseUrl: access.baseUrl,
          volume: volumeName,
        });
        await access.registration.release();
      } else {
        registry = access;
      }
    }
  }
  try {
    heartbeat('shell-step: cloning branch into workspace volume');
    await cloneIntoVolume(volumeName, meta, branch, helperImage, registry !== null);

    let result: Awaited<ReturnType<typeof runEphemeralContainer>>;
    try {
      if (registry) {
        const allowlist = await buildRegistryAllowlist(
          registry,
          `refs/remotes/origin/${meta.defaultBranch}`,
          async (command, maxOutputBytes) => ({
            stdout: await runHelper(command, volumeName, helperImage, meta.token, maxOutputBytes),
          }),
          '/workspace/repo'
        );
        registry.registration.setAllowlist(allowlist);
        const npmrc = renderNpmrc(registry.registries, registry.baseUrl, registry.token);
        const yarnrc = renderYarnrc(registry.registries, registry.baseUrl);
        // The content reaches the files through env, never through the
        // container's command line, so the author command cannot read it from
        // /proc. It does pass through the worker's docker client arguments,
        // like every other step env value; it is the per-step proxy token.
        const writeRes = await backend.runHelper(
          {
            argv: [
              '-c',
              'mkdir -p /workspace/.auto-swe/home && ' +
                'printf \'%s\' "$AUTO_SWE_NPMRC" > /workspace/.auto-swe/home/.npmrc && ' +
                'chmod 644 /workspace/.auto-swe/home/.npmrc && ' +
                'if [ -n "$AUTO_SWE_YARNRC" ]; then ' +
                'printf \'%s\' "$AUTO_SWE_YARNRC" > /workspace/.auto-swe/home/.yarnrc.yml && ' +
                'chmod 644 /workspace/.auto-swe/home/.yarnrc.yml; fi',
            ],
            entrypoint: 'sh',
            env: [`AUTO_SWE_NPMRC=${npmrc}`, `AUTO_SWE_YARNRC=${yarnrc ?? ''}`],
            image: helperImage,
            volumes: [{ source: volumeName, target: '/workspace' }],
          },
          { heartbeatLabel: 'shell-step: registry config' }
        );
        if (writeRes.exitCode !== 0) {
          throw new Error(
            `registry config helper exited ${writeRes.exitCode}: ${(writeRes.stderr ?? writeRes.stdout ?? '').slice(0, 500)}`
          );
        }
      }

      heartbeat('shell-step: running command');
      const effectiveEgressAllowlist = meta.teamEgressAllowlist;
      result = await runEphemeralContainer({
        command: input.command,
        cpus: input.cpus,
        egressAllowlist: effectiveEgressAllowlist,
        ...(registry
          ? {
              env: {
                HOME: '/workspace/.auto-swe/home',
                ...Object.fromEntries(
                  registry.env
                    .filter((e) => !e.startsWith('NPM_CONFIG_USERCONFIG='))
                    .map((e) => {
                      const i = e.indexOf('=');
                      return [e.slice(0, i), e.slice(i + 1)] as [string, string];
                    })
                ),
                NPM_CONFIG_USERCONFIG: '/workspace/.auto-swe/home/.npmrc',
              },
              extraAddHosts: [`${DOCKER_HOST_ALIAS}:host-gateway`],
            }
          : {}),
        image: input.image,
        memory: input.memory,
        network: input.network ?? 'none',
        timeoutMs: input.timeoutMs,
        workdir: '/workspace/repo',
        workspaceMount: volumeName,
      });
    } finally {
      // Revoke the step's proxy token as soon as the command is done; the
      // outer finally covers a failure before this point (clone, allowlist).
      await registry?.registration.release().catch(() => {});
    }

    // Defense in depth. `cloneIntoVolume` now scrubs the credential out of
    // `origin`, so `/workspace/repo/.git/config` no longer holds it and a
    // `git remote -v` / `cat .git/config` from the author's command has
    // nothing to print. This redaction stays anyway: it costs nothing, and it
    // still catches a token that reaches stdout by some other route (an
    // operator-supplied clone URL shape `splitCloneCredential` failed to
    // parse, or a future caller that reintroduces one). Every downstream use
    // (artifact body, truncated summary tail) reads from these redacted
    // copies, never from `result.stdout`/`result.stderr` directly.
    const redactedStdout = redactToken(result.stdout, meta.token);
    const redactedStderr = redactToken(result.stderr, meta.token);

    const fullLog = `$ ${input.command}\n--- stdout ---\n${redactedStdout}\n--- stderr ---\n${redactedStderr}`;
    const runId = await currentWorkflowRunId();
    const artifact = await putArtifact({
      body: fullLog,
      contentType: 'text/plain; charset=utf-8',
      kind: 'shell.step',
      runId,
    }).catch(() => null);

    const commandPassed = result.exitCode === 0 && !result.signal;

    // The command text leaves this activity twice: in the auto-commit message
    // pushed to the repository, and in the lesson recalled into later
    // implementer prompts and listed to operators. Both get the masked form —
    // the run's own token by value, then anything shaped like a credential.
    // Masked whole and sliced after, for the same straddling-cut reason as the
    // summary tail below.
    const maskedCommand = maskCredentialShapes(
      redactSecrets(input.command, [meta.token, meta.gitAuthHeader])
    );
    let finalize: FinalizeResult = { filesChanged: [] };
    let finalizeError: string | undefined;
    if (commandPassed) {
      heartbeat('shell-step: finalizing workspace');
      try {
        finalize = await finalizeWorkspaceVolume(
          volumeName,
          branch,
          maskedCommand.slice(0, 80),
          helperImage,
          meta.token,
          meta.cleanUrl,
          meta.gitAuthHeader
        );
      } catch (err) {
        // Recorded rather than rethrown: the author's command may not be
        // idempotent, so the step must not invite an activity-level retry that
        // re-runs it. The failure still reaches the node's `onFail` policy
        // through `passed` below, which is where a deliberate retry lives.
        //
        // This catches the whole finalize step, not only the push: the helper
        // container may fail to start, the config rewrite, staging or the commit
        // may fail, or a command after a *successful* push (rev-parse, diff) may
        // fail. The message therefore says the workspace could not be finalized
        // rather than asserting which command failed inside it — a diagnosis we
        // do not have.
        const e = err as { stderr?: unknown; message?: unknown };
        const raw =
          (typeof e.stderr === 'string' && e.stderr) ||
          (typeof e.message === 'string' && e.message) ||
          String(err);
        finalizeError = redactToken(raw, meta.token).slice(0, 500);
      }
    }

    // Redact before truncating, not after: a token straddling the truncation
    // cut would otherwise leave an unredacted fragment in the summary (and in
    // Temporal history) because the split-token halves no longer match the
    // full token string.
    const tail = truncate(`${redactedStderr || redactedStdout}`.trim(), 4000);
    const passSummary = finalizeError
      ? `shell step ran (exit 0) but finalizing the workspace failed, so the change may not be on ` +
        `${branch} — step failed: ${finalizeError}`
      : `shell step passed (exit 0; ${finalize.filesChanged.length} files changed)`;

    // Phase-8 memory hook: a shell step that actually changed files + pushed
    // is worth remembering — usually a codemod or auto-fix the team will want
    // future runs to know about. Fire-and-forget; never fails the step.
    if (commandPassed && !finalizeError && finalize.filesChanged.length > 0) {
      // 5-second cap so a slow embedding provider can't extend the shell-step
      // activity past its timeout after the real work has already succeeded.
      await recordLessonBackground({
        agentKey: 'shellStep',
        lessonSummary: `Shell step modified ${finalize.filesChanged.length} file(s) on branch ${branch}: ${maskedCommand.slice(0, 200)}`,
        metadata: {
          branch,
          ...(finalize.committedSha ? { committedSha: finalize.committedSha } : {}),
          filesChanged: finalize.filesChanged.slice(0, 50),
          image: input.image,
        },
        rationale: `Shell step succeeded (exit 0) and committed working-tree changes.`,
        repoId: requireRepoId(input.request, 'shell'),
        temporalWorkflowId: currentWorkflowId(),
      });
    }

    // `passed` is the step's outcome, not just the command's verdict: a command
    // that succeeded but whose changes never reached the branch has not done
    // what the step is for. `persisted` still separates the two failure kinds,
    // and `exitCode` carries the command's own result.
    const persisted = !finalizeError;
    const passed = commandPassed && persisted;

    const summary = !commandPassed
      ? `shell step failed (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}): ${tail}`
      : passSummary;

    return {
      artifactId: artifact?.id,
      exitCode: result.exitCode,
      filesChanged: finalize.filesChanged,
      passed,
      persisted,
      ...(result.signal ? { signal: result.signal } : {}),
      ...(finalize.committedSha ? { committedSha: finalize.committedSha } : {}),
      // Defense in depth: every summary built from `tail`/`passSummary` below
      // this point is redacted again here, not just the finalizeError branch
      // above — so a future code path that forgets to thread the token
      // through still can't leak it. (The `ShellImageNotAllowedError` early
      // return above this point is a separate return statement and skips
      // this redaction entirely — safe today because that path never touches
      // repo/git output, only `assertShellImageAllowed`'s own message.)
      summary: redactToken(summary, meta.token),
    };
  } finally {
    // Idempotent: a second release after the inner one is a no-op.
    await registry?.registration.release().catch(() => {});
    await backend.removeVolume(volumeName);
  }
}
