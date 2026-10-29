import { skimProof } from './brief.js';
import {
  DEFAULT_SENSITIVE_PATHS,
  isTestFile,
  MAX_PATH_LENGTH,
  matchesAny,
  NON_SOURCE_GLOBS,
  TEST_SKIP_PATTERN,
} from './paths.js';
import type {
  ChangedFile,
  Classification,
  EffectivePolicy,
  EvaluationSignals,
  Reason,
  RiskClass,
} from './types.js';

function touches(file: ChangedFile, globs: readonly string[]): boolean {
  return (
    matchesAny(file.path, globs) ||
    (file.previousPath !== undefined && matchesAny(file.previousPath, globs))
  );
}

/** Most of a patch that is scanned for skip markers; beyond it the file is an exclusion. */
export const MAX_SCANNED_PATCH_CHARS = 2 * 1024 * 1024;

/**
 * Whether any ADDED line switches a test off. GitHub patches carry no file
 * headers, so a line starting with `+++` is content ("++i" added) unless it is
 * exactly a header (`+++ a/`, `+++ b/`, `+++ /dev/null`) before the first hunk.
 */
function addsSkipMarker(patch: string): boolean {
  let inHunk = false;
  let start = 0;
  while (start <= patch.length) {
    let end = patch.indexOf('\n', start);
    if (end === -1) {
      end = patch.length;
    }
    if (patch.startsWith('@@', start)) {
      inHunk = true;
    } else if (patch.charCodeAt(start) === 0x2b /* + */) {
      const header =
        !inHunk &&
        (patch.startsWith('+++ a/', start) ||
          patch.startsWith('+++ b/', start) ||
          patch.startsWith('+++ /dev/null', start));
      if (!header && TEST_SKIP_PATTERN.test(patch.slice(start + 1, end))) {
        return true;
      }
    }
    start = end + 1;
  }
  return false;
}

const validCount = (n: number): boolean => Number.isFinite(n) && n >= 0;

/** Top two directory levels of a file, or '.' at the root. */
function directoryOf(path: string): string {
  const segments = path.split('/');
  segments.pop();
  return segments.slice(0, 2).join('/') || '.';
}

function exclusion(code: string, message: string, paths?: string[]): Reason {
  return { code, message, severity: 'exclusion', ...(paths && paths.length > 0 ? { paths } : {}) };
}

function raise(code: string, message: string, paths?: string[]): Reason {
  return { code, message, severity: 'raise', ...(paths && paths.length > 0 ? { paths } : {}) };
}

/**
 * Deterministic class from signals alone. It fails closed: an error, a missing
 * signal, or any hard exclusion makes the PR HIGH and never auto-eligible.
 */
export function classify(signals: EvaluationSignals, effective: EffectivePolicy): Classification {
  const reasons: Reason[] = [];
  const sensitive = [...new Set([...DEFAULT_SENSITIVE_PATHS, ...effective.sensitivePaths])];
  const { files } = signals;

  if (signals.evaluationError !== undefined) {
    reasons.push(exclusion('evaluation-error', `Evaluation failed: ${signals.evaluationError}`));
  }
  if (signals.policyErrors !== undefined && signals.policyErrors.length > 0) {
    reasons.push(
      exclusion(
        'policy-file-invalid',
        `The repository policy file is invalid and was not applied: ${signals.policyErrors.slice(0, 3).join('; ')}`
      )
    );
  }
  if (signals.policyFileChanged) {
    reasons.push(
      exclusion('policy-file-changed', 'The PR changes .auto-swe/pr-policy.yml', [
        '.auto-swe/pr-policy.yml',
      ])
    );
  }

  const hits = (predicate: (file: ChangedFile) => boolean): string[] =>
    files.filter(predicate).map((file) => file.path);

  const tooLong = hits((f) => f.path.length > MAX_PATH_LENGTH);
  if (tooLong.length > 0) {
    reasons.push(exclusion('path-too-long', 'A changed path is too long to evaluate', tooLong));
  }
  const sensitiveHits = hits((f) => touches(f, sensitive));
  if (sensitiveHits.length > 0) {
    reasons.push(exclusion('sensitive-path', 'The PR touches sensitive paths', sensitiveHits));
  }
  const invalidCounts = hits((f) => !validCount(f.additions) || !validCount(f.deletions));
  if (invalidCounts.length > 0) {
    reasons.push(
      exclusion('invalid-counts', 'A changed file reports invalid line counts', invalidCounts)
    );
  }
  const removedTests = hits(
    (f) =>
      (f.status === 'removed' && isTestFile(f.path)) ||
      (f.status === 'renamed' &&
        f.previousPath !== undefined &&
        isTestFile(f.previousPath) &&
        !isTestFile(f.path))
  );
  if (removedTests.length > 0) {
    reasons.push(exclusion('removed-test', 'The PR removes test files', removedTests));
  }
  const oversized = hits(
    (f) => isTestFile(f.path) && f.patch !== undefined && f.patch.length > MAX_SCANNED_PATCH_CHARS
  );
  if (oversized.length > 0) {
    reasons.push(
      exclusion('patch-too-large-to-scan', 'A test patch is too large to scan for skips', oversized)
    );
  }
  const skipped = hits(
    (f) =>
      isTestFile(f.path) &&
      f.patch !== undefined &&
      f.patch.length <= MAX_SCANNED_PATCH_CHARS &&
      addsSkipMarker(f.patch)
  );
  if (skipped.length > 0) {
    reasons.push(
      exclusion('test-skip-added', 'The PR adds a skip or only marker to tests', skipped)
    );
  }
  const unverifiable = hits(
    (f) =>
      f.status !== 'removed' &&
      f.patch === undefined &&
      !(f.status === 'renamed' && f.similarity === 100 && f.additions === 0 && f.deletions === 0)
  );
  if (unverifiable.length > 0) {
    reasons.push(
      exclusion('unverifiable-patch', 'A changed file has no patch to inspect', unverifiable)
    );
  }
  const unscanned = hits(
    (f) => isTestFile(f.path) && f.patch === undefined && f.additions > 0 && f.status !== 'removed'
  );
  if (unscanned.length > 0) {
    reasons.push(
      exclusion('unverifiable-test-patch', 'A changed test file has no patch to scan', unscanned)
    );
  }

  if (signals.scannerFindingCount > 0) {
    reasons.push(
      exclusion(
        'scanner-finding',
        `Security scanners reported ${signals.scannerFindingCount} finding(s)`
      )
    );
  }
  if (signals.maxReviewSeverity === null) {
    reasons.push(exclusion('review-signal-missing', 'No review result is available'));
  } else if (signals.maxReviewSeverity === 'WARNING' || signals.maxReviewSeverity === 'CRITICAL') {
    reasons.push(
      exclusion('review-severity', `A reviewer raised a ${signals.maxReviewSeverity} finding`)
    );
  }

  const highRisk = hits((f) => touches(f, effective.highRiskPaths));
  if (highRisk.length > 0) {
    reasons.push(raise('high-risk-path', 'The PR touches paths marked high risk', highRisk));
  }

  const counted = files.filter((f) => skimProof(f, effective.ignoredFromSkim) === null);
  const lines = counted.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (lines > effective.highLines) {
    reasons.push(raise('high-lines', `${lines} changed lines exceeds ${effective.highLines}`));
  }

  const hasExclusion = reasons.some((r) => r.severity === 'exclusion');
  let riskClass: RiskClass = hasExclusion || reasons.length > 0 ? 'HIGH' : 'LOW';

  if (riskClass === 'LOW') {
    if (files.length === 0 || counted.length === 0) {
      reasons.push(raise('nothing-to-evaluate', 'There is no changed content to evaluate'));
    }
    if (lines > effective.maxLowLines) {
      reasons.push(raise('size-lines', `${lines} changed lines exceeds ${effective.maxLowLines}`));
    }
    if (counted.length > effective.maxLowFiles) {
      reasons.push(raise('size-files', `${counted.length} files exceeds ${effective.maxLowFiles}`));
    }
    const dirs = new Set(counted.map((f) => directoryOf(f.path))).size;
    if (dirs > effective.maxLowDirs) {
      reasons.push(raise('size-dirs', `${dirs} directories exceeds ${effective.maxLowDirs}`));
    }
    const source = counted.filter(
      (f) => !isTestFile(f.path) && !matchesAny(f.path, NON_SOURCE_GLOBS)
    );
    if (source.length > 0 && !counted.some((f) => isTestFile(f.path))) {
      reasons.push(
        raise(
          'no-tests',
          'Source files changed but no test file did',
          source.map((f) => f.path)
        )
      );
    }
    if (reasons.length > 0) {
      riskClass = 'STANDARD';
    }
  }

  const requiredApprovers =
    riskClass === 'HIGH'
      ? effective.highApprovers
      : riskClass === 'STANDARD'
        ? effective.standardApprovers
        : effective.lowApprovers;
  return {
    autoEligible: riskClass === 'LOW' && !hasExclusion,
    reasons,
    requiredApprovers,
    riskClass,
  };
}
