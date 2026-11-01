export type RiskClass = 'LOW' | 'STANDARD' | 'HIGH';
/** `enforce` holds the status to auto's rules but never arms auto-merge. */
export type PrEvaluationMode = 'off' | 'advisory' | 'enforce' | 'auto';
export type ReviewSeverity = 'PASS' | 'INFO' | 'WARNING' | 'CRITICAL';

export type ChangedFile = {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  /** 0-100, renames only. */
  similarity?: number;
  /** Unified patch; absent for binary or oversized files. */
  patch?: string;
};

export type Reason = {
  code: string;
  severity: 'exclusion' | 'raise' | 'info';
  message: string;
  paths?: string[];
};

export type PolicyThresholds = {
  maxLowLines: number;
  maxLowFiles: number;
  maxLowDirs: number;
  /** Changed lines above which a PR is HIGH. */
  highLines: number;
  lowApprovers: number;
  standardApprovers: number;
  highApprovers: number;
};

/** What a repository may say about itself; it can only make evaluation stricter. */
export type RepoPolicyFile = {
  version: 1;
  sensitivePaths?: string[];
  highRiskPaths?: string[];
  maxLowLines?: number;
  maxLowFiles?: number;
  maxLowDirs?: number;
  highLines?: number;
  lowApprovers?: number;
  standardApprovers?: number;
  highApprovers?: number;
  ignoredFromSkim?: string[];
  /** Keys the file used that try to relax a rule; `mergePolicy` reports each one. */
  relaxations?: string[];
};

export type PolicyFloor = PolicyThresholds & {
  sensitivePaths: string[];
  highRiskPaths?: string[];
};

export type EffectivePolicy = PolicyThresholds & {
  sensitivePaths: string[];
  highRiskPaths: string[];
  ignoredFromSkim: string[];
};

export type EvaluationSignals = {
  files: ChangedFile[];
  draft: boolean;
  scannerFindingCount: number;
  maxReviewSeverity: ReviewSeverity | null;
  evaluationError?: string;
  policyFileChanged: boolean;
  /** Parse errors of the repository policy file; any entry fails closed. */
  policyErrors?: string[];
};

export type Classification = {
  riskClass: RiskClass;
  requiredApprovers: number;
  reasons: Reason[];
  /** Class LOW and zero exclusions; says nothing about mode or evidence. */
  autoEligible: boolean;
};

export type SkimProof = 'exact-rename' | 'whitespace-only';

/** What the ticket asked for, as the run extracted it. Untrusted text: the brief escapes it. */
export type BriefIntent = {
  criteria: string[];
  openQuestions: string[];
};

/**
 * What the run that opened the pull request recorded, as numbers and verdicts: never a model's
 * words, a command's output or a page's text. A null says it could not be read or was not recorded.
 */
export type BriefEvidence = {
  /** The run's own test result at this head; null when no review of this exact head was found. */
  tests: { failing: number; passing: number; total: number } | null;
  /** Browser checks the run captured, by kind; null when it captured none. */
  ui: { screenshots: number; traces: number; videos: number } | null;
  /** The host's verdict on this head's checks right now; null when it could not be read. */
  ci: 'passed' | 'failed' | 'pending' | 'none' | null;
  /** The run's page in the dashboard; null when no run or no web address is known. */
  runUrl: string | null;
};

/**
 * One finding of the review network's pass over exactly this head, after selection. Every string
 * is model output: the brief and any comment built from it escape it. `line` is set only when it
 * falls inside the file's patch, so a comment can be anchored to it.
 */
export type BriefFinding = {
  category: string;
  description: string;
  file: string;
  line: number | null;
  reviewer: string;
  severity: 'WARNING' | 'CRITICAL';
  suggestedFix: string;
};

export type Brief = {
  /** Every file that is not provably skimmable, in the order to read it. */
  path: { path: string; why: string; verify: string; flagged: boolean }[];
  skim: { path: string; proof: SkimProof }[];
  claimsToVerify: string[];
  markdown: string;
};

export type PrReview = {
  login: string;
  state: string;
  commitId: string;
  /** The reviewer's numeric host user id, as a string; absent or null when the host gave none. */
  userId?: string | null;
};

/** People whose approval never counts, by the host's stable id and by (lower-cased) login. */
export type ExcludedIdentities = { logins: ReadonlySet<string>; ids: ReadonlySet<string> };

export type ApprovalState = { approvers: string[]; required: number; satisfied: boolean };

export type CommitStatus = {
  state: 'pending' | 'success' | 'failure';
  /** At most 140 characters (GitHub's limit). */
  description: string;
};
