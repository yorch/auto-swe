/**
 * What the review page shows for a pull request, put together from the latest stored evaluation
 * and a live read of the files. Pure: the route does the reading and the visibility checks, so
 * this can be tested without a database or a host.
 *
 * The stored brief is JSON written by the worker, possibly by an older version of it, so each part
 * is read on its own and a part that does not parse is left out instead of failing the page.
 */
import { lineInDiff, readingOrder } from '@auto-swe/shared/lib/prEvaluation';
import type {
  PullRequestCockpitEvaluation,
  PullRequestCockpitFile,
  PullRequestCockpitFiles,
  PullRequestCockpitFinding,
} from '@auto-swe/shared/types/api';
import { z } from 'zod';
import type { PullFilesResult } from './githubPullFiles.js';

const PathEntry = z.object({
  flagged: z.boolean(),
  path: z.string(),
  verify: z.string(),
  why: z.string(),
});
const SkimEntry = z.object({ path: z.string(), proof: z.string() });
const Intent = z.object({
  criteria: z.array(z.string()),
  handled: z
    .array(
      z.object({
        note: z.string(),
        question: z.string(),
        resolution: z.enum(['implemented', 'left-unchanged']),
      })
    )
    .optional(),
  openQuestions: z.array(z.string()),
});
const Evidence = z.object({
  ci: z.enum(['passed', 'failed', 'pending', 'none']).nullable(),
  runUrl: z.string().nullable(),
  tests: z.object({ failing: z.number(), passing: z.number(), total: z.number() }).nullable(),
  ui: z.object({ screenshots: z.number(), traces: z.number(), videos: z.number() }).nullable(),
});
const Finding = z.object({
  category: z.string(),
  description: z.string(),
  file: z.string(),
  line: z.number().int().nullable(),
  reviewer: z.string(),
  severity: z.enum(['WARNING', 'CRITICAL']),
  suggestedFix: z.string(),
});
const Reason = z.object({
  code: z.string(),
  message: z.string(),
  paths: z.array(z.string()).optional(),
  severity: z.string(),
});

/** An element-wise lenient read: the entries that parse are kept, the rest dropped. */
function entries<T>(schema: z.ZodType<T>, value: unknown): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function part<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The evaluation row as the route selects it. */
export type EvaluationRow = {
  brief: unknown;
  createdAt: Date;
  headSha: string;
  id: string;
  mode: string;
  reasons: unknown;
  requiredApprovers: number;
  riskClass: string;
  statusState: string;
};

const RISK_CLASSES = ['LOW', 'STANDARD', 'HIGH'] as const;

/** The most patch text one answer carries; the host allows 3000 files of up to 200 000 each. */
export const MAX_TOTAL_PATCH_CHARS = 3_000_000;

/** A class this code does not know reads as HIGH, as the evaluator fails closed. */
function riskClassOf(value: string): 'LOW' | 'STANDARD' | 'HIGH' {
  return RISK_CLASSES.find((c) => c === value) ?? 'HIGH';
}

export type CockpitParts = {
  evaluation: PullRequestCockpitEvaluation | null;
  files: PullRequestCockpitFiles;
};

export function assembleCockpit(input: {
  evaluation: EvaluationRow | null;
  /** The head the stored pull request row names; used while the host cannot be read. */
  storedHeadSha: string;
  files: PullFilesResult;
}): CockpitParts {
  const { files: read, storedHeadSha } = input;
  const liveHead = read.type === 'ok' ? read.headSha : storedHeadSha;
  const brief = asRecord(input.evaluation?.brief);
  const pathByFile = new Map(entries(PathEntry, brief.path).map((e) => [e.path, e]));
  const skimByFile = new Map(entries(SkimEntry, brief.skim).map((e) => [e.path, e.proof]));
  const stale =
    input.evaluation !== null && input.evaluation.headSha.toLowerCase() !== liveHead.toLowerCase();

  let files: PullRequestCockpitFiles;
  const patchOf = new Map<string, string>();
  if (read.type === 'ok') {
    const digestOf = new Map(read.files.map((f) => [f.path, f.patchDigest]));
    // Patches go out in reading order until the answer would pass the cap; a file past it is
    // named but has no patch, exactly like a binary or oversized one, and so cannot be marked
    // viewed. The files a reviewer reads first are the ones that keep theirs.
    let patchChars = 0;
    const items: PullRequestCockpitFile[] = readingOrder(read.files).map((file) => {
      const stored = pathByFile.get(file.path);
      const room =
        file.patch !== undefined && patchChars + file.patch.length <= MAX_TOTAL_PATCH_CHARS;
      if (room && file.patch !== undefined) {
        patchChars += file.patch.length;
        patchOf.set(file.path, file.patch);
      }
      return {
        additions: file.additions,
        deletions: file.deletions,
        flagged: stored?.flagged ?? false,
        patch: room ? (file.patch ?? null) : null,
        patchDigest: room ? (digestOf.get(file.path) ?? null) : null,
        path: file.path,
        previousPath: file.previousPath ?? null,
        skim: skimByFile.get(file.path) ?? null,
        status: file.status,
        verify: stored?.verify ?? null,
        why: stored?.why ?? null,
      };
    });
    files = {
      headSha: read.headSha,
      items,
      state: read.state,
      truncated: read.truncated,
      type: 'ok',
    };
  } else {
    files = { reason: read.reason, type: 'unavailable' };
  }

  if (input.evaluation === null) {
    return { evaluation: null, files };
  }
  const anchorable = read.type === 'ok' && !stale;
  const findings: PullRequestCockpitFinding[] = entries(Finding, brief.findings).map((f) => ({
    ...f,
    anchored: anchorable && f.line !== null && lineInDiff(patchOf.get(f.file), f.line),
  }));
  const intent = part(Intent, brief.intent);
  const evaluation: PullRequestCockpitEvaluation = {
    claimsToVerify: Array.isArray(brief.claimsToVerify)
      ? brief.claimsToVerify.filter((c): c is string => typeof c === 'string')
      : [],
    createdAt: input.evaluation.createdAt.toISOString(),
    evidence: part(Evidence, brief.evidence),
    findings,
    headSha: input.evaluation.headSha,
    id: input.evaluation.id,
    intent: intent ? { ...intent, handled: intent.handled ?? [] } : null,
    mode: input.evaluation.mode,
    reasons: entries(Reason, input.evaluation.reasons).map((r) => ({
      code: r.code,
      message: r.message,
      paths: r.paths ?? [],
      severity: r.severity,
    })),
    requiredApprovers: input.evaluation.requiredApprovers,
    riskClass: riskClassOf(input.evaluation.riskClass),
    stale,
    statusState: input.evaluation.statusState,
  };
  return { evaluation, files };
}

/** What a stored mark needs to be checked against the file it was made on. */
export type ViewedRow = { patchDigest: string; path: string };

/**
 * The paths a person has viewed: a mark counts only while the file's patch is the one that was
 * viewed, so a push that changes a file puts it back among the unread. A file with no patch has no
 * digest to match and is never viewed.
 */
export function viewedPaths(files: PullRequestCockpitFiles, rows: readonly ViewedRow[]): string[] {
  if (files.type !== 'ok') {
    return [];
  }
  const digestOf = new Map(rows.map((row) => [row.path, row.patchDigest]));
  return files.items
    .filter((item) => item.patchDigest !== null && digestOf.get(item.path) === item.patchDigest)
    .map((item) => item.path);
}
