/**
 * The `AgentTrace.error` tags the worker writes when a runtime security scanner
 * blocks (or warns on) an implementer tool call.
 *
 * Three processes read these strings: the worker writes them, the gateway's
 * security-events endpoint filters on them at the DB level, and the trajectory
 * scorer counts them as guardrail hits. They are plain strings in a text
 * column, so nothing but a shared definition keeps the writer and the readers
 * agreeing — a reader keyed on a string no writer produces matches nothing and
 * fails silently.
 */
export const SECURITY_TRACE_ERRORS = {
  /** `writeFile` refused by the pre-write content check (a CRITICAL rule). */
  CONTENT_BLOCK: 'blocked by content security check',
  /** `writeFile` allowed, but the pre-write content check raised warnings. */
  CONTENT_WARN: 'content security warning',
  /** `writeFile` refused because the path matches a SENSITIVE_FILE pattern. */
  FILE_BLOCK: 'blocked by sensitive file scanner',
  /** `bash` refused by the shell-command scanner. */
  SHELL_BLOCK: 'blocked by shell command scanner',
} as const;

export type SecurityTraceError = (typeof SECURITY_TRACE_ERRORS)[keyof typeof SECURITY_TRACE_ERRORS];

/** The tags that mean a scanner refused the tool call (a warning is not a block). */
export const SECURITY_BLOCK_TRACE_ERRORS: readonly SecurityTraceError[] = [
  SECURITY_TRACE_ERRORS.CONTENT_BLOCK,
  SECURITY_TRACE_ERRORS.FILE_BLOCK,
  SECURITY_TRACE_ERRORS.SHELL_BLOCK,
];

/** True when a trace error records a security-scanner block. */
export function isSecurityBlockTraceError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }
  return SECURITY_BLOCK_TRACE_ERRORS.some((tag) => error.startsWith(tag));
}
