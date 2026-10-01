import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_RUN_MAX_FILE_BYTES,
  AGENT_RUN_MAX_GATED_DIFF_CHARS,
} from '@auto-swe/shared/lib/agentRun';
import type { CodeSecurityFinding, FileChange } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import {
  evaluatePushPolicy,
  formatViolations,
  parseRawDiffZ,
  type RawChange,
} from '../lib/agentRunPolicy.js';
import type { AgentTracer } from '../lib/agentTracer.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { execShellAsync, throwIfActivityCancelled } from '../lib/execUtils.js';
import { checkSensitiveFilePath } from '../lib/sensitiveFileScanner.js';
import { parseDiffToFileChanges } from './utils.js';
import { shellQuote, type Workspace } from './workspace.js';

/**
 * The trusted half of an agent run.
 *
 * The agent runs as root in its own container and can replace `git`, `sh` or
 * `sed` there, rewrite `.git/config`, add `refs/replace/*`, set a textconv
 * driver or mark every file `-diff`. So nothing about WHAT may be published is
 * decided in that container, and the push credential never enters it. Instead:
 *
 *   1. the working tree (never `.git`) is copied out by the Docker daemon and
 *      into a FRESH container — same image, clean clone at the exact base SHA,
 *      engine-only commands, no agent process ever ran in it;
 *   2. the tree is committed there, the change is read back there with
 *      `--text --no-textconv --no-ext-diff` and `GIT_NO_REPLACE_OBJECTS=1`;
 *   3. the deterministic policy and the LLM gate judge THAT commit;
 *   4. only a {@link GatedCommit} can be pushed, by SHA, from that container.
 *
 * Whatever the agent did to its own container, the worst it can change is which
 * bytes get copied — and exactly the bytes copied are what is scanned and pushed.
 */

/** Largest working-tree archive copied out of the agent container. */
export const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

const GIT =
  'GIT_NO_REPLACE_OBJECTS=1 GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 git ' +
  '-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null ' +
  '-c core.autocrlf=false -c commit.gpgsign=false';

const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;

// ── Proof of the gate ────────────────────────────────────────────────────────

declare const gatePassed: unique symbol;

/**
 * A commit in the trusted container that has been through the deterministic
 * policy and the LLM gate. The brand is not exported as a value and the only
 * producer is {@link gateTrustedCommit}, so {@link pushGatedCommit} cannot be
 * reached with an unchecked SHA: it does not type-check.
 */
export interface GatedCommit {
  readonly [gatePassed]: true;
  readonly sha: string;
  readonly baseSha: string;
  /** The container the commit lives in; a push from any other is refused. */
  readonly workspaceId: string;
  readonly diff: string;
  readonly filesChanged: FileChange[];
  readonly codeSecurityFindings: CodeSecurityFinding[];
}

function mintGated(fields: Omit<GatedCommit, typeof gatePassed>): GatedCommit {
  return fields as GatedCommit;
}

// ── Step 1-2: copy the tree into the trusted container and commit ────────────

/**
 * Copy the agent's working tree (not `.git`) into the trusted container and
 * replace the trusted checkout's tree with it. Returns the size copied.
 */
export async function importAgentTree(
  agent: Workspace,
  trusted: Workspace,
  opts: { maxBytes?: number } = {}
): Promise<number> {
  const maxBytes = opts.maxBytes ?? MAX_EXPORT_BYTES;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-run-'));
  const archive = path.join(dir, 'tree.tar');
  try {
    // Best-effort shrinking, run with the agent's own (untrusted) tooling. If it
    // lies or fails, the only consequence is a larger archive, which the size
    // cap below judges from the host's side. Ignored files (node_modules, build
    // output) are never published, so they are not worth copying; `.git` is
    // moved aside so a large history does not count against the cap.
    await agent.execCapture(
      'git clean -fdXq >/dev/null 2>&1; mv .git ../.agent-git-moved >/dev/null 2>&1; true',
      { timeoutMs: 300_000 }
    );
    // Freeze whatever the agent left running (`nohup … &`) so the copy is one
    // consistent snapshot rather than a tree still being written to. Best-effort:
    // the copy below is what is scanned and pushed either way, so a process that
    // survives only costs consistency, never correctness.
    try {
      await execShellAsync(`docker pause ${shellQuote(agent.containerId)}`, {
        heartbeatLabel: 'agent run: freezing the agent container',
        timeoutMs: 30_000,
      });
    } catch {
      /* already stopped, or the runtime cannot pause */
    }
    // The daemon produces the archive, not the agent's `tar`.
    await execShellAsync(
      `docker cp ${shellQuote(`${agent.containerId}:/workspace/target-repo/.`)} - > ${shellQuote(archive)}`,
      { heartbeatLabel: 'agent run: exporting the working tree', timeoutMs: 600_000 }
    );
    const { size } = await fs.stat(archive);
    if (size > maxBytes) {
      throw ApplicationFailure.nonRetryable(
        `The working tree is ${size} bytes, over the ${maxBytes} byte export limit. ` +
          'Keep dependency and build output in ignored paths.',
        'AGENT_RUN_EXPORT_TOO_LARGE'
      );
    }
    await trusted.exec('rm -rf /stage && mkdir /stage');
    await execShellAsync(
      `docker cp - ${shellQuote(`${trusted.containerId}:/stage`)} < ${shellQuote(archive)}`,
      { heartbeatLabel: 'agent run: importing the working tree', timeoutMs: 600_000 }
    );
    // Replace the clean checkout's tree with the copied one. `.git` of the
    // checkout is the trusted repository; a `.git` inside the copy is dropped.
    await trusted.exec(
      [
        'set -e',
        'rm -rf /stage/.git',
        'find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +',
        'cp -a /stage/. .',
        'rm -rf /stage',
      ].join('\n'),
      { timeoutMs: 600_000 }
    );
    return size;
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

export type CommitOutcome = { empty: true } | { empty: false; sha: string };

/** Commit whatever the copied tree changes against the base. */
export async function commitTrustedTree(
  trusted: Workspace,
  baseSha: string,
  message: string
): Promise<CommitOutcome> {
  const head = (await trusted.exec(`${GIT} rev-parse HEAD`)).trim();
  if (head !== baseSha) {
    throw ApplicationFailure.nonRetryable(
      'The trusted checkout is not at the base commit the agent started from',
      'AGENT_RUN_BASE_MISMATCH'
    );
  }
  await trusted.exec(`${GIT} add -A`);
  const staged = await trusted.execCapture(`${GIT} diff --cached --quiet`);
  if (staged.exitCode === 0) {
    return { empty: true };
  }
  // The squash is by construction: one engine-authored commit on the base, so a
  // secret the agent committed and then deleted never reaches the remote.
  await trusted.exec(`${GIT} commit -q --no-verify -m ${shellQuote(message)}`);
  const sha = (await trusted.exec(`${GIT} rev-parse HEAD`)).trim();
  if (!SHA_RE.test(sha)) {
    throw new Error('unexpected commit id');
  }
  return { empty: false, sha };
}

// ── Step 3: deterministic policy, then the LLM gate ──────────────────────────

export interface GateDeps {
  scanDiffForSecurityIssues: typeof scanDiffForSecurityIssues;
  scanDiffForCodeIssues: typeof scanDiffForCodeIssues;
  checkSensitivePath: (p: string) => Promise<string | null>;
}

const realDeps: GateDeps = {
  checkSensitivePath: checkSensitiveFilePath,
  scanDiffForCodeIssues,
  scanDiffForSecurityIssues,
};

async function readChanges(trusted: Workspace, baseSha: string, sha: string): Promise<RawChange[]> {
  const out = await trusted.exec(
    `${GIT} diff --raw -z --no-renames --no-abbrev --no-ext-diff --no-textconv ${baseSha} ${sha}`
  );
  return parseRawDiffZ(out);
}

/** Blob sizes and which blobs contain a NUL byte, read from the trusted object store. */
async function inspectBlobs(
  trusted: Workspace,
  changes: RawChange[]
): Promise<{ sizes: Map<string, number>; binary: Set<string> }> {
  const shas = [
    ...new Set(
      changes
        .filter((c) => c.newMode !== '000000' && c.newMode !== '120000' && c.newMode !== '160000')
        .map((c) => c.newSha)
    ),
  ];
  const sizes = new Map<string, number>();
  const binary = new Set<string>();
  if (shas.length === 0) {
    return { binary, sizes };
  }
  const list = `${shas.join('\n')}\n`;
  const sizeOut = await trusted.execStdin(
    `${GIT} cat-file --batch-check='%(objectname) %(objectsize)'`,
    list
  );
  for (const line of sizeOut.split('\n')) {
    const m = line.match(/^([0-9a-f]+) (\d+)$/);
    if (m) {
      sizes.set(m[1] as string, Number(m[2]));
    }
  }
  // A NUL byte is the same test git itself applies to call a file binary, but
  // made on the content: `.gitattributes` cannot talk it out of it.
  const script = [
    'while read -r sha; do',
    `  a=$(${GIT} cat-file blob "$sha" | wc -c)`,
    `  b=$(${GIT} cat-file blob "$sha" | tr -d '\\000' | wc -c)`,
    '  [ "$a" -eq "$b" ] || echo "$sha"',
    'done',
  ].join('\n');
  const eligible = shas.filter((s) => (sizes.get(s) ?? 0) <= AGENT_RUN_MAX_FILE_BYTES);
  if (eligible.length > 0) {
    const out = await trusted.execStdin(`sh -c ${shellQuote(script)}`, `${eligible.join('\n')}\n`);
    for (const line of out.split('\n')) {
      if (/^[0-9a-f]+$/.test(line.trim())) {
        binary.add(line.trim());
      }
    }
  }
  return { binary, sizes };
}

function policyFailure(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, 'AGENT_RUN_PUSH_POLICY');
}

/**
 * Judge the commit in the trusted container and, only if it passes, return the
 * proof needed to push it.
 *
 * Order: deterministic policy -> size bound -> advisory code scan -> LLM gate.
 * Every failure is non-retryable and fails closed:
 *  - policy violation          -> AGENT_RUN_PUSH_POLICY
 *  - diff too large to scan    -> AGENT_RUN_DIFF_TOO_LARGE
 *  - gate cannot complete      -> SECURITY_GATE_UNAVAILABLE
 *  - CRITICAL finding          -> SECURITY_GATE_FAILURE (same text as the
 *                                 implementer's gate, so alerts keyed on it match)
 */
export async function gateTrustedCommit(
  trusted: Workspace,
  args: {
    baseSha: string;
    sha: string;
    allowWorkflowChanges: boolean;
    tracer: AgentTracer;
  },
  deps: GateDeps = realDeps
): Promise<GatedCommit> {
  const { baseSha, sha, tracer } = args;

  let changes: RawChange[];
  let blobs: { sizes: Map<string, number>; binary: Set<string> };
  try {
    changes = await readChanges(trusted, baseSha, sha);
    blobs =
      changes.length > 0
        ? await inspectBlobs(trusted, changes)
        : { binary: new Set(), sizes: new Map() };
  } catch (err) {
    // Cannot say what is being published, so it is not published.
    throw policyFailure(
      `The change could not be classified: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const violations = await evaluatePushPolicy({
    allowWorkflowChanges: args.allowWorkflowChanges,
    binaryBlobs: blobs.binary,
    blobSizes: blobs.sizes,
    changes,
    checkSensitivePath: deps.checkSensitivePath,
  });
  tracer.addActivityEvent({
    name: 'agent_run.push_policy',
    outputJson: { changedFiles: changes.length, violations },
  });
  if (violations.length > 0) {
    throw policyFailure(`Push policy refused this change:\n${formatViolations(violations)}`);
  }

  let diff: string;
  try {
    diff = await trusted.exec(
      `${GIT} diff --text --no-textconv --no-ext-diff --no-color --no-renames ${baseSha} ${sha}`
    );
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `The diff could not be read for scanning: ${err instanceof Error ? err.message : String(err)}`,
      'AGENT_RUN_DIFF_TOO_LARGE'
    );
  }
  if (diff.length > AGENT_RUN_MAX_GATED_DIFF_CHARS) {
    // The gate reads the whole diff in one model call; a truncated scan would be
    // a bypass (put the payload past the cut), so an unscannable change is refused.
    throw ApplicationFailure.nonRetryable(
      `The diff is ${diff.length} characters, over the ${AGENT_RUN_MAX_GATED_DIFF_CHARS} the security gate can scan.`,
      'AGENT_RUN_DIFF_TOO_LARGE'
    );
  }

  // Advisory: a scanner that cannot run costs findings, never the run.
  let codeSecurityFindings: CodeSecurityFinding[] = [];
  try {
    codeSecurityFindings = await deps.scanDiffForCodeIssues(diff);
  } catch (err) {
    tracer.addActivityEvent({
      error: err instanceof Error ? err.message : String(err),
      name: 'code_security.scan',
      outputJson: { degraded: true },
    });
  }
  if (codeSecurityFindings.length > 0) {
    tracer.addActivityEvent({
      name: 'code_security.scan',
      outputJson: { count: codeSecurityFindings.length, findings: codeSecurityFindings },
    });
  }

  let securityResult: Awaited<ReturnType<typeof scanDiffForSecurityIssues>>;
  try {
    securityResult = await deps.scanDiffForSecurityIssues(diff);
  } catch (err) {
    // A gate that errors is not a gate that passed. Typed so it is never
    // retried into a second spend, and so nothing is pushed on the way out.
    // A budget stop keeps its own type: it is the more specific truth.
    if (err instanceof ApplicationFailure && err.type === 'BUDGET_EXCEEDED') {
      throw err;
    }
    throw ApplicationFailure.nonRetryable(
      `Security gate could not complete: ${err instanceof Error ? err.message : String(err)}`,
      'SECURITY_GATE_UNAVAILABLE'
    );
  }
  if (!securityResult.passed) {
    const findingsSummary = securityResult.findings
      .map(
        (f) =>
          `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.category}: ${f.description}`
      )
      .join('\n');
    throw ApplicationFailure.nonRetryable(
      `Security scan failed with critical findings:\n${findingsSummary}`,
      'SECURITY_GATE_FAILURE',
      { findings: securityResult.findings }
    );
  }

  return mintGated({
    baseSha,
    codeSecurityFindings,
    diff,
    filesChanged: parseDiffToFileChanges(diff),
    sha,
    workspaceId: trusted.containerId,
  });
}

// ── Step 4: push by SHA from the trusted container ───────────────────────────

/**
 * The only code path in agent runs that sends the platform credential anywhere.
 * Takes a {@link GatedCommit}, so a push with no passing gate does not compile,
 * and pushes the immutable object id rather than `HEAD` or a branch name.
 */
export async function pushGatedCommit(
  trusted: Workspace,
  commit: GatedCommit,
  branch: string
): Promise<void> {
  if (commit.workspaceId !== trusted.containerId) {
    throw ApplicationFailure.nonRetryable(
      'The gated commit does not belong to this workspace',
      'AGENT_RUN_PUSH_POLICY'
    );
  }
  if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw ApplicationFailure.nonRetryable(
      `Refusing branch name ${branch}`,
      'AGENT_RUN_PUSH_POLICY'
    );
  }
  if (!SHA_RE.test(commit.sha)) {
    throw ApplicationFailure.nonRetryable(
      'Refusing a malformed commit id',
      'AGENT_RUN_PUSH_POLICY'
    );
  }
  // Never publish on behalf of a run that has been cancelled.
  throwIfActivityCancelled();
  await trusted.gitAuthed(`push origin ${shellQuote(`${commit.sha}:refs/heads/${branch}`)}`);
}
