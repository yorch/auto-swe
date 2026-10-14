import { asyncLocalStorage, log } from '@temporalio/activity';

/**
 * Inside an activity the Temporal logger (exported with the activity's trace
 * context); outside one — embedding pricing, boot-time checks, where `log`
 * throws — the console, so the message is never dropped.
 */
export function logError(message: string, meta?: Record<string, unknown>): void {
  if (asyncLocalStorage.getStore()) {
    log.error(message, meta ?? {});
  } else {
    console.error(message, meta ?? {});
  }
}

/** {@link logError}'s warning-level twin: the Temporal logger, else the console. */
export function logWarn(message: string, meta?: Record<string, unknown>): void {
  if (asyncLocalStorage.getStore()) {
    log.warn(message, meta ?? {});
  } else {
    console.warn(message, meta ?? {});
  }
}

/**
 * An audit line: stdout as always, plus — inside an activity — the Temporal
 * logger, which exports it to Loki with the activity span's trace id and the
 * workflow id, activity type and attempt as attributes. Outside an activity
 * (a unit test, a boot-time call) it is only the stdout line.
 *
 * The caller redacts first; the same text goes to both sinks.
 */
export function auditLog(line: string): void {
  console.log(line);
  if (asyncLocalStorage.getStore()) {
    log.info(line, { audit: true });
  }
}
