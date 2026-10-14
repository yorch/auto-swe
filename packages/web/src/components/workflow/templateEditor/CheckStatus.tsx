import { type CheckSnapshot, checkMessage } from './checkHelpers';

interface CheckStatusProps {
  /** The click's snapshot while it still matches the spec; null once an edit made it stale. */
  checkResult: CheckSnapshot | null;
  shownErrors: number;
  shownWarnings: number;
}

/** Always mounted so assistive tech announces the text when it changes. */
export function CheckStatus({ checkResult, shownErrors, shownWarnings }: CheckStatusProps) {
  return (
    <div
      aria-live="polite"
      className={
        checkResult
          ? 'border-b border-ink-600 bg-ink-950/60 px-4 py-1.5 text-xs text-paper-300'
          : 'sr-only'
      }
      role="status"
    >
      {checkResult && (
        <span key={checkResult.seq}>
          {checkMessage(checkResult.server, shownErrors, shownWarnings)}
        </span>
      )}
    </div>
  );
}
