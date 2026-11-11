import { z } from 'zod';

/**
 * Ask-and-resume: the shapes an activity returns when its agent needs a person
 * before it can go on, and the shapes it is re-invoked with once they answer.
 *
 * Pure on purpose (no Node imports): the workflow dispatcher imports this module
 * from the Temporal isolate. Everything here is bounded, because the result
 * crosses Temporal's history and the answers come from a person.
 */

/** The most questions one pause asks. */
export const MAX_QUESTIONS = 4;

/** One question, in the shape of Claude Code's `AskUserQuestion` tool. */
export const NeedsInputQuestionSchema = z.object({
  header: z.string().min(1).max(12),
  multiSelect: z.boolean().default(false),
  options: z
    .array(
      z.object({
        description: z.string().max(500).default(''),
        label: z.string().min(1).max(100),
      })
    )
    .min(2)
    .max(4),
  question: z.string().min(1).max(500),
});
export type NeedsInputQuestion = z.infer<typeof NeedsInputQuestionSchema>;

/** The whole `tool_input` of an `AskUserQuestion` call. */
export const AskUserQuestionInputSchema = z.object({
  questions: z.array(NeedsInputQuestionSchema).min(1).max(MAX_QUESTIONS),
});

/** The most characters of work-so-far a resume state carries. */
export const MAX_RESUME_DIGEST_CHARS = 8192;
/** The most characters a surface-specific resume payload serializes to. */
export const MAX_RESUME_SURFACE_CHARS = 16_384;
/** The most characters a whole {@link NeedsInput} serializes to. */
export const MAX_NEEDS_INPUT_CHARS = 65_536;
/** The most characters of one human answer. */
export const MAX_ANSWER_CHARS = 2000;

const HEX = /^[0-9a-f]+$/i;

/** The working tree at the moment of the pause, kept as a patch in the artifact store. */
export const ResumeSnapshotSchema = z.strictObject({
  artifactId: z.string().min(1).max(100),
  baseSha: z.string().min(7).max(64).regex(HEX),
  branch: z.string().min(1).max(255).optional(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64).regex(HEX),
});
export type ResumeSnapshot = z.infer<typeof ResumeSnapshotSchema>;

const boundedJson = (max: number) => (value: unknown) => JSON.stringify(value).length <= max;

/** What the activity needs to continue after the answer. Opaque to everything but the activity that made it. */
export const ResumeStateSchema = z.strictObject({
  asked: z
    .array(z.strictObject({ header: z.string().max(12), question: z.string().max(500) }))
    .max(MAX_QUESTIONS),
  digest: z.string().max(MAX_RESUME_DIGEST_CHARS),
  snapshot: ResumeSnapshotSchema.nullable(),
  surface: z
    .record(z.string(), z.unknown())
    .refine(boundedJson(MAX_RESUME_SURFACE_CHARS), 'surface is too large')
    .optional(),
  version: z.literal(1),
});
export type ResumeState = z.infer<typeof ResumeStateSchema>;

export const NeedsInputSchema = z.strictObject({
  questions: z.array(NeedsInputQuestionSchema).min(1).max(MAX_QUESTIONS),
  resume: ResumeStateSchema,
});
export type NeedsInput = z.infer<typeof NeedsInputSchema>;

export const ResumeAnswerSchema = z.strictObject({
  answer: z.union([
    z.string().max(MAX_ANSWER_CHARS),
    z.array(z.string().max(MAX_ANSWER_CHARS)).max(20),
  ]),
  question: z.string().min(1).max(500),
});
export type ResumeAnswer = z.infer<typeof ResumeAnswerSchema>;

/** What an activity is re-invoked with after the human answered. */
export const ResumeInputSchema = z.strictObject({
  // One answer per question, plus the person's optional free-text note.
  answers: z.array(ResumeAnswerSchema).max(MAX_QUESTIONS + 1),
  // The last run at the round limit: the agent cannot ask again and must finish on its own judgement.
  final: z.literal(true).optional(),
  resume: ResumeStateSchema,
  round: z.number().int().min(1),
});
export type ResumeInput = z.infer<typeof ResumeInputSchema>;

/**
 * Whether an activity's `result` is a pause: an object whose `needsInput`
 * passes {@link NeedsInputSchema} and serializes within
 * {@link MAX_NEEDS_INPUT_CHARS}. Anything malformed (a wrong version, an
 * oversized digest, too many questions) is not a pause.
 */
export function isNeedsInput(result: unknown): result is { needsInput: NeedsInput } {
  if (typeof result !== 'object' || result === null || !('needsInput' in result)) {
    return false;
  }
  const parsed = NeedsInputSchema.safeParse((result as { needsInput: unknown }).needsInput);
  return parsed.success && JSON.stringify(parsed.data).length <= MAX_NEEDS_INPUT_CHARS;
}
