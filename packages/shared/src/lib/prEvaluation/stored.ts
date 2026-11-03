import type { BriefEvidence, BriefFinding, BriefIntent, StoredBrief } from './types.js';

/** The same counts the comment shows, so the stored copy never holds more than a reader sees. */
export const MAX_STORED_CRITERIA = 20;
export const MAX_STORED_QUESTIONS = 10;
const MAX_STORED_FINDINGS = 50;
const MAX_STORED_TEXT = 1_000;
const MAX_STORED_URL = 500;

function bounded(text: string, max: number = MAX_STORED_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function storedIntent(intent: BriefIntent): NonNullable<StoredBrief['intent']> {
  const openQuestions = intent.openQuestions.slice(0, MAX_STORED_QUESTIONS).map((q) => bounded(q));
  const handled = (intent.handled ?? [])
    .filter((h) => openQuestions.includes(bounded(h.question)))
    .map((h) => ({
      note: bounded(h.note),
      question: bounded(h.question),
      resolution: h.resolution,
    }));
  return {
    criteria: intent.criteria.slice(0, MAX_STORED_CRITERIA).map((c) => bounded(c)),
    ...(handled.length > 0 ? { handled } : {}),
    openQuestions,
  };
}

function storedEvidence(evidence: BriefEvidence): NonNullable<StoredBrief['evidence']> {
  return {
    ci: evidence.ci,
    runUrl: evidence.runUrl === null ? null : bounded(evidence.runUrl, MAX_STORED_URL),
    tests: evidence.tests,
    ui: evidence.ui,
  };
}

function storedFinding(finding: BriefFinding): BriefFinding {
  return {
    category: bounded(finding.category, 100),
    description: bounded(finding.description),
    file: bounded(finding.file, MAX_STORED_URL),
    line: finding.line,
    reviewer: bounded(finding.reviewer, 100),
    severity: finding.severity,
    suggestedFix: bounded(finding.suggestedFix),
  };
}

/**
 * The structured parts of a brief that otherwise live only inside its comment text, bounded for
 * the row. Every string is still model or ticket text: whoever reads it renders it as plain text.
 * A part the evaluation did not have is left out, so an older row and a newer one read the same way.
 */
export function briefDetail(
  intent: BriefIntent | undefined,
  evidence: BriefEvidence | undefined,
  findings: readonly BriefFinding[] | undefined
): Pick<StoredBrief, 'evidence' | 'findings' | 'intent'> {
  return {
    ...(intent ? { intent: storedIntent(intent) } : {}),
    ...(evidence ? { evidence: storedEvidence(evidence) } : {}),
    ...(findings && findings.length > 0
      ? { findings: findings.slice(0, MAX_STORED_FINDINGS).map(storedFinding) }
      : {}),
  };
}
