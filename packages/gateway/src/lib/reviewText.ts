/**
 * What a reviewer may write from the review page, checked before it is stored or sent as them.
 *
 * Two kinds of text are refused because the platform reads them as something else. Anything holding
 * the automation marker is taken for the platform's own text, so engagement and feedback skip it, and
 * a person must not be able to pass theirs off as the platform's. A line that starts `/auto-swe fix`
 * starts a run when it reaches the host as a review body, an inline comment or a discussion comment,
 * and the page has a button for that, so it is never smuggled in as ordinary prose.
 */
import { parseFeedbackCommand } from '@auto-swe/shared/automation';
import { isPlatformText } from '@auto-swe/shared/lib/prEvaluation';

/** The longest comment or review body the page sends; the host allows far more. */
export const MAX_REVIEW_TEXT_CHARS = 4000;

export type ReviewTextProblem = 'empty' | 'too-long' | 'platform-marker' | 'command';

export const REVIEW_TEXT_MESSAGES: Record<ReviewTextProblem, string> = {
  command:
    'Text that starts a run with /auto-swe fix is not sent from here. Use "Send back to the agent" for that.',
  empty: 'Write something first.',
  'platform-marker': 'That text contains a marker the platform reserves for its own comments.',
  'too-long': `Keep it to ${MAX_REVIEW_TEXT_CHARS} characters.`,
};

/** The first reason `text` cannot be sent, or null when it can. */
export function reviewTextProblem(text: string): ReviewTextProblem | null {
  if (text.trim() === '') {
    return 'empty';
  }
  if (text.length > MAX_REVIEW_TEXT_CHARS) {
    return 'too-long';
  }
  if (isPlatformText(text)) {
    return 'platform-marker';
  }
  if (parseFeedbackCommand(text) !== null) {
    return 'command';
  }
  return null;
}
