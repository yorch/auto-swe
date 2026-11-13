import { RUN_TRIGGERS } from '@auto-swe/shared/lib/runTrigger';
import { describe, expect, it } from 'vitest';
import { describeRunInitiator, RUN_TRIGGER_LABELS } from './runInitiator';

describe('RUN_TRIGGER_LABELS', () => {
  it('names every trigger with non-empty text', () => {
    for (const trigger of RUN_TRIGGERS) {
      expect(RUN_TRIGGER_LABELS[trigger].length).toBeGreaterThan(0);
    }
    expect(Object.keys(RUN_TRIGGER_LABELS).sort()).toEqual([...RUN_TRIGGERS].sort());
  });
});

describe('describeRunInitiator', () => {
  it('names a person and keeps the email as the second line', () => {
    expect(
      describeRunInitiator({
        initiatedBy: { email: 'ada@example.com', id: 'u1', name: 'Ada Lovelace' },
        trigger: 'work-request',
      })
    ).toEqual({
      kind: 'person',
      primary: 'Ada Lovelace',
      secondary: 'ada@example.com',
      title: 'Ada Lovelace <ada@example.com>',
    });
  });

  it('falls back to the email, with no second line, when the name is null or blank', () => {
    const base = { email: 'ada@example.com', id: 'u1' };
    expect(describeRunInitiator({ initiatedBy: { ...base, name: null } })).toEqual({
      kind: 'person',
      primary: 'ada@example.com',
      title: 'ada@example.com',
    });
    expect(describeRunInitiator({ initiatedBy: { ...base, name: '  ' } })).toEqual({
      kind: 'person',
      primary: 'ada@example.com',
      title: 'ada@example.com',
    });
  });

  it('names a service principal', () => {
    expect(
      describeRunInitiator({
        initiatedByService: { id: 's1', name: 'ci-bot' },
        trigger: 'service-token',
      })
    ).toEqual({
      kind: 'service',
      primary: 'ci-bot',
      secondary: 'Service principal',
      title: 'ci-bot',
    });
  });

  it('prefers the person when both are present', () => {
    expect(
      describeRunInitiator({
        initiatedBy: { email: 'a@b.c', id: 'u', name: null },
        initiatedByService: { id: 's', name: 'bot' },
      }).kind
    ).toBe('person');
  });

  it.each(RUN_TRIGGERS)('shows only the trigger label for a system run (%s)', (trigger) => {
    expect(describeRunInitiator({ initiatedBy: null, initiatedByService: null, trigger })).toEqual({
      kind: 'system',
      primary: RUN_TRIGGER_LABELS[trigger],
      title:
        trigger === 'schedule'
          ? 'Started by the schedule. A manual \u201cRun now\u201d is not attributed to a person.'
          : 'No person is recorded for this run.',
    });
  });

  it('says Not recorded when nothing is recorded, including when the fields are absent', () => {
    const none = {
      kind: 'unknown',
      primary: 'Not recorded',
      title: "Runs started before initiators were tracked don't record who started them.",
    };
    expect(
      describeRunInitiator({ initiatedBy: null, initiatedByService: null, trigger: null })
    ).toEqual(none);
    expect(describeRunInitiator({})).toEqual(none);
  });

  it('labels both retry triggers Re-run', () => {
    expect(RUN_TRIGGER_LABELS['work-request-retry']).toBe('Re-run');
    expect(RUN_TRIGGER_LABELS['template-retry']).toBe('Re-run');
  });

  it('strips control and bidi characters from the name, email and tooltip', () => {
    const who = describeRunInitiator({
      initiatedBy: { email: 'a\u202e@b.c', id: 'u', name: 'Ada\n\u202eLovelace' },
    });
    expect(who.primary).toBe('AdaLovelace');
    expect(who.secondary).toBe('a@b.c');
    expect(who.title).toBe('AdaLovelace <a@b.c>');
  });

  it('falls back to the email when the name is only control characters', () => {
    const who = describeRunInitiator({
      initiatedBy: { email: 'ada@example.com', id: 'u', name: '\u202e\n\u200b' },
    });
    expect(who.primary).toBe('ada@example.com');
    expect(who.secondary).toBeUndefined();
  });

  it('cleans a service name', () => {
    expect(
      describeRunInitiator({ initiatedByService: { id: 's', name: 'bot\u202e\n' } }).primary
    ).toBe('bot');
  });
});
