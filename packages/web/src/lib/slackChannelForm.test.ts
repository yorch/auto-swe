import { describe, expect, it } from 'vitest';
import {
  dollarsToCents,
  emptyChannelForm,
  formToCreateBody,
  formToUpdateBody,
  validateChannelForm,
} from './slackChannelForm';

const valid = () => ({
  ...emptyChannelForm(),
  slackChannelId: 'C01',
  slackTeamId: 'T01',
  teamId: 'team-1',
});

describe('validateChannelForm', () => {
  it('accepts a minimal register form', () => {
    expect(validateChannelForm(valid(), 'create')).toEqual({});
  });

  it('requires the Slack ids only when registering', () => {
    const form = { ...emptyChannelForm(), teamId: 'team-1' };
    expect(Object.keys(validateChannelForm(form, 'create'))).toEqual([
      'slackChannelId',
      'slackTeamId',
    ]);
    expect(validateChannelForm(form, 'edit')).toEqual({});
  });

  it('checks a schedule only while its feature is on, and explains a bad one', () => {
    // Off: the field is hidden, so an error there would be invisible.
    expect(validateChannelForm({ ...valid(), ambientCron: 'nonsense' }, 'edit')).toEqual({});
    expect(
      validateChannelForm({ ...valid(), ambientCron: 'nonsense', ambientEnabled: true }, 'edit')
        .ambientCron
    ).toBeTruthy();
    // The gateway accepts 7 for Sunday, so the form does too.
    expect(
      validateChannelForm({ ...valid(), reactiveCron: '0 9 * * 7', reactiveEnabled: true }, 'edit')
    ).toEqual({});
    expect(validateChannelForm({ ...valid(), ambientCron: '' }, 'edit')).toEqual({});
    const bad = validateChannelForm(
      { ...valid(), ambientCron: '0 25 * * *', ambientEnabled: true },
      'edit'
    );
    expect(bad.ambientCron).toMatch(/hour must be between 0 and 23/);
    const missing = validateChannelForm({ ...valid(), reactiveEnabled: true }, 'edit');
    expect(missing.reactiveCron).toMatch(/needs a cron expression/);
  });

  it('rejects a bad budget and bad overrides', () => {
    const errors = validateChannelForm(
      { ...valid(), budgetDollars: '-5', reactiveCooldownMinutes: '1.5' },
      'edit'
    );
    expect(errors.budgetDollars).toBeDefined();
    expect(errors.reactiveCooldownMinutes).toBeDefined();
  });
});

describe('form to body', () => {
  it('drops an invalid schedule left under a switched-off feature instead of sending it', () => {
    const body = formToUpdateBody({ ...valid(), ambientCron: 'nonsense', ambientEnabled: false });
    expect(body.ambientCron).toBeNull();
  });

  it('keeps a schedule whose feature is off and converts dollars to cents', () => {
    const body = formToUpdateBody({
      ...valid(),
      ambientCron: '0 9 * * 1-5',
      ambientEnabled: false,
      budgetDollars: '12.50',
      reactiveCooldownMinutes: '15',
    });
    expect(body.ambientCron).toBe('0 9 * * 1-5');
    expect(formToUpdateBody({ ...valid(), ambientCron: '  ' }).ambientCron).toBeNull();
    expect(body.monthlyBudgetUsdCents).toBe(1250);
    expect(body.reactiveCooldownMinutes).toBe(15);
    expect(body.orgFlagCooldownHours).toBeNull();
  });

  it('sends a schedule with single spaces between its fields', () => {
    expect(formToUpdateBody({ ...valid(), ambientCron: '0   9 * *\t1' }).ambientCron).toBe(
      '0 9 * * 1'
    );
  });

  it('builds a create body with the Slack ids and trims text', () => {
    const body = formToCreateBody({
      ...valid(),
      ambientCron: ' 0 9 * * * ',
      ambientEnabled: true,
      name: '  #eng  ',
    });
    expect(body).toMatchObject({
      ambientCron: '0 9 * * *',
      name: '#eng',
      slackChannelId: 'C01',
      slackTeamId: 'T01',
      teamId: 'team-1',
    });
  });
});

describe('dollarsToCents', () => {
  it('distinguishes blank, invalid and valid', () => {
    expect(dollarsToCents('')).toBeNull();
    expect(dollarsToCents('abc')).toBeUndefined();
    expect(dollarsToCents('0.1')).toBe(10);
  });
});
