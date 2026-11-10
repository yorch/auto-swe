import { resolveSetting, SETTING_DEFINITIONS } from '@auto-swe/shared/config';

/**
 * The approval due-soon window in hours. A setting read that fails (database down) must not take a
 * desk or an overview with it: the window only orders approvals, so fall back to its default.
 */
export async function readDueSoonHours(log: {
  warn(obj: unknown, msg: string): void;
}): Promise<number> {
  try {
    return await resolveSetting('workflow.approvalDueSoonHours', {});
  } catch (err) {
    log.warn({ err }, 'approval due-soon window unreadable; using its default');
    return SETTING_DEFINITIONS['workflow.approvalDueSoonHours'].defaultValue;
  }
}
