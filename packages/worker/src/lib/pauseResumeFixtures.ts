import type { NeedsInputQuestion, ResumeInput } from '@auto-swe/shared/lib/needsInput';

/** One valid question, as a paused turn reports it. */
export const QUESTIONS: NeedsInputQuestion[] = [
  {
    header: 'DB',
    multiSelect: false,
    options: [
      { description: '', label: 'Postgres' },
      { description: '', label: 'SQLite' },
    ],
    question: 'Which database?',
  },
];

/** A valid {@link ResumeInput} whose surface state is `surface`; `resume` overrides parts of the saved state. */
export function resumeInputFor(
  surface: Record<string, unknown> | undefined,
  resume: Partial<ResumeInput['resume']> = {}
): ResumeInput {
  return {
    answers: [{ answer: 'Postgres', question: 'Which database?' }],
    resume: {
      asked: [{ header: 'DB', question: 'Which database?' }],
      digest: 'Files changed: db.ts',
      snapshot: {
        artifactId: 'art-1',
        baseSha: 'a'.repeat(40),
        bytes: 10,
        sha256: 'b'.repeat(64),
      },
      surface,
      version: 1,
      ...resume,
    },
    round: 2,
  };
}
