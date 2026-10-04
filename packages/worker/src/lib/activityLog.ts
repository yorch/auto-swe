import { asyncLocalStorage, log } from '@temporalio/activity';

export function logError(message: string, meta?: Record<string, unknown>): void {
  if (asyncLocalStorage.getStore()) {
    log.error(message, meta ?? {});
  }
}

export function logWarn(message: string, meta?: Record<string, unknown>): void {
  if (asyncLocalStorage.getStore()) {
    log.warn(message, meta ?? {});
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
