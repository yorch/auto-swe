import { resolveSetting } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import { type PreviewConfigInput, PreviewConfigSchema } from '@auto-swe/shared/lib/previewConfig';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { workBranchOf } from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { BrowserSession, type DriverResult } from '../browser/session.js';
import { PreviewNotReadyError, startAppPreview } from '../lib/appPreview.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { resolveRequestBaseBranch } from '../lib/runBaseBranch.js';
import { withRunDetection } from '../lib/runDetection.js';
import { recordActivityEvidence } from '../lib/runEvidence.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { truncate } from './qualityGates.js';
import {
  createWorkspace,
  fetchBranchesSubcommand,
  shellQuote,
  type Workspace,
} from './workspace.js';

export interface UiVerifyInput {
  request: RepoWorkRequest;
  branch?: string;
  mode?: 'smoke' | 'e2e' | 'both';
  recordVideo?: boolean;
  failOnConsoleErrors?: boolean;
  timeoutMs?: number;
}

export interface UiVerifyPage {
  path: string;
  name?: string;
  status?: number | null;
  errors: string[];
  evidenceId?: string;
}

export interface UiVerifyResult {
  passed: boolean;
  summary: string;
  exitCode: number;
  artifactId?: string;
  pages?: UiVerifyPage[];
  e2e?: { exitCode: number; passed: boolean };
  evidenceIds?: string[];
  /** Evidence the run could not keep (over a configured cap, or unreadable). */
  notes?: string[];
  skipped?: boolean;
}

const DEFAULT_TIMEOUT_MS = 1_200_000;
const LOG_TAIL_BYTES = 4000;
const EVIDENCE_READ_BYTES = 100 * 1024 * 1024;

/** A driver command that reports `ok: false` is a failure, not an empty result. */
function requireDriver(result: DriverResult, what: string): DriverResult {
  if (result.ok !== true) {
    throw new Error(`${what} failed: ${result.error ?? 'the browser driver reported a failure'}`);
  }
  return result;
}

async function checkoutWorkspace(
  request: RepoWorkRequest,
  branchOverride?: string,
  services?: PreviewConfigInput['services']
): Promise<{ repo: Awaited<ReturnType<typeof withRunDetection>>; workspace: Workspace }> {
  const [repo, workflowDefaults] = await Promise.all([
    prisma.connection
      .findUniqueOrThrow({
        include: { installation: { select: { host: true, installationId: true } } },
        where: { id: requireRepoId(request, 'uiVerify') },
      })
      .then(withRunDetection),
    resolveWorkflowDefaults(),
  ]);
  const branch = branchOverride ?? workBranchOf(request, workflowDefaults.branchPrefix);
  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);
  const baseBranch = await resolveRequestBaseBranch(request, repo);
  const workspace = await createWorkspace(
    authedCloneUrl,
    branch,
    baseBranch,
    executorImageFor(repo),
    undefined,
    undefined,
    { detectedStack: repo.detectedStack, services, teamId: repo.teamId }
  );
  try {
    await workspace.gitAuthed(fetchBranchesSubcommand([branch]));
    await workspace.exec(`git reset --hard origin/${shellQuote(branch)}`);
  } catch (error) {
    await workspace.destroy();
    throw error;
  }
  return { repo, workspace };
}

export async function runUiVerify(input: UiVerifyInput): Promise<UiVerifyResult> {
  const repoId = requireRepoId(input.request, 'uiVerify');
  const repoRow = await prisma.connection.findUniqueOrThrow({
    select: { previewConfig: true },
    where: { id: repoId },
  });
  if (!repoRow.previewConfig) {
    return {
      exitCode: 0,
      passed: true,
      skipped: true,
      summary: 'UI verification skipped: the repository has no app preview configured',
    };
  }
  const config = PreviewConfigSchema.parse(repoRow.previewConfig as PreviewConfigInput);
  const mode = input.mode ?? (config.e2e ? 'both' : 'smoke');
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failOnConsoleErrors = input.failOnConsoleErrors ?? true;
  const { workspace } = await checkoutWorkspace(input.request, input.branch, config.services);
  const evidenceIds: string[] = [];
  const pages: UiVerifyPage[] = [];
  const notes: string[] = [];
  let artifactId: string | undefined;
  let preview: Awaited<ReturnType<typeof startAppPreview>> | undefined;
  let session: BrowserSession | undefined;
  let appLog = '';
  let failure: string | undefined;
  let e2e: UiVerifyResult['e2e'];

  const saveEvidence = async (
    kind: 'screenshot' | 'video' | 'trace' | 'log',
    body: Buffer | string,
    details: {
      caption?: string;
      pageUrl?: string;
      width?: number;
      height?: number;
    } = {}
  ): Promise<string | undefined> => {
    const result = await recordActivityEvidence({
      body,
      contentType:
        kind === 'screenshot'
          ? 'image/png'
          : kind === 'video'
            ? 'video/webm'
            : kind === 'trace'
              ? 'application/zip'
              : 'text/plain; charset=utf-8',
      kind,
      source: 'uiVerify',
      ...details,
    });
    if (!result.ok) {
      notes.push(
        `${kind} evidence was not saved: ${result.reason === 'too_large' ? 'over the configured size limit' : 'the run is at its evidence-count limit'}`
      );
      return undefined;
    }
    evidenceIds.push(result.evidenceId);
    if (kind === 'log') {
      artifactId = result.artifactId;
    }
    return result.evidenceId;
  };

  try {
    heartbeat('uiVerify: starting preview');
    try {
      preview = await startAppPreview(workspace, config, { timeoutMs: config.readyTimeoutMs });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (error instanceof PreviewNotReadyError) {
        appLog = error.logTail;
      }
    }

    if (preview && (mode === 'smoke' || mode === 'both')) {
      try {
        session = await BrowserSession.start(workspace, {
          allowedHosts: config.allowedHosts ?? [],
          maxVideoBytes: await resolveSetting('uiValidation.maxVideoBytes'),
          recordVideo: input.recordVideo ?? true,
          trace: true,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (session) {
        for (const smoke of config.smoke ?? []) {
          heartbeat(`uiVerify: ${smoke.path}`);
          const page: UiVerifyPage = {
            errors: [],
            name: smoke.name,
            path: smoke.path,
            status: null,
          };
          try {
            // Any driver command can report `ok: false` (a navigation timeout, a
            // selector that never appears). Treating that as an empty result
            // would let a broken page pass the gate, so each one is required.
            const response = requireDriver(
              await session.call({
                cmd: 'goto',
                url: `${preview.baseUrl}${smoke.path}`,
              }),
              'navigation'
            );
            page.status = typeof response?.status === 'number' ? response.status : null;
            if (typeof page.status === 'number' && page.status >= 500) {
              page.errors.push(`HTTP ${page.status}`);
            }
            if (smoke.waitFor) {
              requireDriver(
                await session.call({ cmd: 'wait', selector: smoke.waitFor }),
                `wait for ${smoke.waitFor}`
              );
            }
            const screenshot = requireDriver(
              await session.call({
                cmd: 'screenshot',
                path: `smoke-${pages.length}.png`,
              }),
              'screenshot'
            );
            if (typeof screenshot.file !== 'string') {
              throw new Error('screenshot failed: the browser driver returned no file');
            }
            page.evidenceId = await saveEvidence(
              'screenshot',
              await session.readOutFile(screenshot.file, EVIDENCE_READ_BYTES),
              {
                caption: smoke.name ?? smoke.path,
                ...(typeof screenshot.height === 'number' ? { height: screenshot.height } : {}),
                ...(typeof screenshot.url === 'string' ? { pageUrl: screenshot.url } : {}),
                ...(typeof screenshot.width === 'number' ? { width: screenshot.width } : {}),
              }
            );
            const events = requireDriver(await session.call({ cmd: 'events' }), 'page diagnostics');
            if (Array.isArray(events?.pageErrors)) {
              page.errors.push(...events.pageErrors.map(String));
            }
            if (failOnConsoleErrors && Array.isArray(events?.console)) {
              page.errors.push(
                ...events.console
                  .filter(
                    (item) =>
                      typeof item === 'object' &&
                      item !== null &&
                      (item as { type?: string }).type === 'error'
                  )
                  .map((item) => String((item as { text?: unknown }).text ?? 'console error'))
              );
            }
          } catch (error) {
            page.errors.push(error instanceof Error ? error.message : String(error));
          }
          pages.push(page);
        }
      }
    }

    if (preview && mode !== 'smoke') {
      if (!config.e2e) {
        failure ??= 'E2E mode requested but no e2e command is configured';
      } else {
        heartbeat('uiVerify: running e2e');
        try {
          const result = await workspace.execCapture(
            `CI=1 sh -c ${shellQuote(config.e2e.command)}`,
            { timeoutMs }
          );
          e2e = { exitCode: result.exitCode, passed: result.exitCode === 0 && !result.signal };
          if (!e2e.passed) {
            failure ??= `E2E command failed with exit code ${result.exitCode}`;
          }
        } catch (error) {
          failure ??= `E2E command could not run: ${error instanceof Error ? error.message : String(error)}`;
          e2e = { exitCode: 1, passed: false };
        }
        let root = '';
        try {
          root = (await workspace.exec('pwd')).trim();
        } catch (error) {
          failure ??= `Could not locate the e2e results directory: ${error instanceof Error ? error.message : String(error)}`;
        }
        const collect = async (
          glob: string,
          kind: 'screenshot' | 'video' | 'trace',
          limit: number
        ) => {
          if (!root) {
            return;
          }
          let files: string[] = [];
          try {
            const listing = await workspace.exec(
              `find ${shellQuote(config.e2e?.resultsDir ?? 'test-results')} -maxdepth 6 -type f -iname ${shellQuote(glob)} -print 2>/dev/null | head -n ${limit}`
            );
            files = listing.split('\n').filter(Boolean);
          } catch (error) {
            failure ??= `Could not list ${kind} evidence: ${error instanceof Error ? error.message : String(error)}`;
            return;
          }
          for (const file of files) {
            // One unreadable or over-limit file must not cost the rest: a throw
            // here would escape the activity and re-run the whole preview.
            try {
              await saveEvidence(kind, await workspace.readFile(`${root}/${file}`, 100_000_000), {
                caption: file,
              });
            } catch (error) {
              failure ??= `Could not save ${kind} evidence from ${file}: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        };
        await collect('*.png', 'screenshot', 30);
        await collect('*.webm', 'video', 5);
        await collect('trace.zip', 'trace', 5);
      }
    }
  } finally {
    if (session) {
      let output: Awaited<ReturnType<BrowserSession['close']>> | undefined;
      try {
        output = await session.close();
      } catch (error) {
        failure ??= `Could not read browser evidence: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (output) {
        notes.push(...output.errors.map((message) => `browser evidence was not read: ${message}`));
        // Each artifact is persisted on its own: a storage failure on the
        // recording must not cost the trace that was finalized beside it.
        const artifacts = [
          ['video', output.video, 'UI verification recording'],
          ['trace', output.trace, 'UI verification trace'],
        ] as const;
        for (const [kind, body, caption] of artifacts) {
          if (!body) {
            continue;
          }
          try {
            await saveEvidence(kind, body, { caption });
          } catch (error) {
            failure ??= `Could not save ${kind} evidence: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
    }
    if (preview) {
      appLog = await preview.logTail(LOG_TAIL_BYTES).catch(() => appLog);
      await preview.stop().catch((error) => {
        failure ??= `Could not stop app preview: ${error instanceof Error ? error.message : String(error)}`;
      });
    }
    await saveEvidence('log', appLog, { caption: 'ui.log' }).catch((error) => {
      failure ??= `Could not save app log: ${error instanceof Error ? error.message : String(error)}`;
    });
    await workspace.destroy();
  }

  const pageFailures = pages.flatMap((page) =>
    page.errors.map((error) => `${page.name ?? page.path}: ${error}`)
  );
  if (pageFailures.length > 0) {
    failure ??= pageFailures.join('; ');
  }
  const passed = !failure && (e2e?.passed ?? true);
  return {
    ...(artifactId ? { artifactId } : {}),
    ...(e2e ? { e2e } : {}),
    evidenceIds,
    exitCode: passed ? 0 : 1,
    ...(notes.length > 0 ? { notes } : {}),
    pages,
    passed,
    summary: truncate(
      passed ? 'UI verification passed' : `UI verification failed: ${failure ?? 'checks failed'}`,
      4000
    ),
  };
}
