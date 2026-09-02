import { asyncLocalStorage, log } from '@temporalio/activity';

export function logError(message: string, meta?: Record<string, unknown>): void {
  if (asyncLocalStorage.getStore()) {
    log.error(message, meta ?? {});
  }
}
