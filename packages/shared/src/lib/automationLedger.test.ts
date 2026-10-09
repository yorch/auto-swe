import { describe, expect, it, vi } from 'vitest';
import {
  recordAutomationActivity,
  refusalKey,
  SCHEDULE_FIRE_SOURCE,
  TEMPLATE_WEBHOOK_SOURCE,
} from './automationLedger.js';

describe('automation ledger rows for schedules and webhooks', () => {
  it('keys a refusal by owner, reason and hour', () => {
    const at = (iso: string) =>
      refusalKey(SCHEDULE_FIRE_SOURCE, 's1', 'org-budget-exceeded', new Date(iso));
    expect(at('2026-10-01T10:05:00Z')).toBe(at('2026-10-01T10:59:00Z'));
    expect(at('2026-10-01T10:05:00Z')).not.toBe(at('2026-10-01T11:00:00Z'));
  });

  it('records one row, owner as subject and scope, never on a repository', async () => {
    const create = vi.fn(async () => ({}));
    await recordAutomationActivity({ automationFire: { create } } as never, {
      key: 'k',
      outcome: 'STARTED',
      ownerId: 'tpl-1',
      source: TEMPLATE_WEBHOOK_SOURCE,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dedupeKey: 'k',
        repoKey: '',
        scopeKey: 'tpl-1',
        source: TEMPLATE_WEBHOOK_SOURCE,
        subjectKey: 'tpl-1',
      }),
    });
  });

  it('never throws: a repeat is ignored, anything else is reported', async () => {
    const onError = vi.fn();
    const failing = (err: unknown) =>
      ({ automationFire: { create: vi.fn(async () => Promise.reject(err)) } }) as never;
    const row = {
      key: 'k',
      outcome: 'STARTED',
      ownerId: 'x',
      source: SCHEDULE_FIRE_SOURCE,
    } as const;
    await recordAutomationActivity(failing({ code: 'P2002' }), row, onError);
    expect(onError).not.toHaveBeenCalled();
    await recordAutomationActivity(failing(new Error('down')), row, onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
