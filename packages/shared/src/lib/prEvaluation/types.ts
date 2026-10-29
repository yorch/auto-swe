export type RiskClass = 'LOW' | 'STANDARD' | 'HIGH';
export type PrEvaluationMode = 'off' | 'advisory' | 'auto';
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

export type Brief = {
  focus: { path: string; why: string; verify: string }[];
  skim: { path: string; proof: SkimProof }[];
  claimsToVerify: string[];
  markdown: string;
};

export type PrReview = { login: string; state: string; commitId: string };

export type ApprovalState = { approvers: string[]; required: number; satisfied: boolean };

export type CommitStatus = {
  state: 'pending' | 'success' | 'failure';
  /** At most 140 characters (GitHub's limit). */
  description: string;
};
