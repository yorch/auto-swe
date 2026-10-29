import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { SETTING_DEFINITIONS } from './registry.js';

describe('retention settings', () => {
  const accepts = (key: keyof typeof SETTING_DEFINITIONS, value: unknown) =>
    SETTING_DEFINITIONS[key].schema.safeParse(value).success;

  it('audit.configLogRetentionDays is 0 (forever) or between a year and ten years', () => {
    const key = 'audit.configLogRetentionDays';
    for (const ok of [0, 365, 3650]) {
      expect(accepts(key, ok), String(ok)).toBe(true);
    }
    for (const bad of [30, 364, 3651, -1, 400.5, '365', null]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
    expect(SETTING_DEFINITIONS[key].defaultValue).toBe(0);
    expect(SETTING_DEFINITIONS[key].overridableAt).toEqual([]);
    expect(SETTING_DEFINITIONS[key].requiredRole).toBe('ADMIN');
  });

  it('analytics.activityRetentionDays is at least a week', () => {
    const key = 'analytics.activityRetentionDays';
    for (const ok of [7, 90, 3650]) {
      expect(accepts(key, ok), String(ok)).toBe(true);
    }
    for (const bad of [3, 6, 0, 3651]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
    expect(SETTING_DEFINITIONS[key].defaultValue).toBe(90);
  });

  it('page-view events are off by default', () => {
    expect(SETTING_DEFINITIONS['analytics.uiEventsEnabled'].defaultValue).toBe(false);
  });
});

describe('git author settings', () => {
  const accepts = (key: keyof typeof SETTING_DEFINITIONS, value: unknown) =>
    SETTING_DEFINITIONS[key].schema.safeParse(value).success;

  it('are defined in the git group with template/team/org overrides', () => {
    const defaults = {
      'git.authorEmail': 'auto-swe@localhost',
      'git.authorName': 'auto-swe',
      'git.launcherAttribution': 'none',
    } as const;
    for (const [key, value] of Object.entries(defaults)) {
      const def = SETTING_DEFINITIONS[key as keyof typeof defaults];
      expect(def.defaultValue, key).toBe(value);
      expect(def.group, key).toBe('git');
      expect(def.overridableAt, key).toEqual(['WORKFLOW_TEMPLATE', 'TEAM', 'ORGANIZATION']);
      // The identity written on every commit is ADMIN-only (a team lead could otherwise forge
      // provenance); crediting the launcher stays with the team lead.
      expect(def.requiredRole, key).toBe(key === 'git.launcherAttribution' ? 'LEAD' : 'ADMIN');
      expect(def.runPinned, key).toBe(false);
    }
  });

  it('git.authorName rejects empty, overlong, control-character and angle-bracket values', () => {
    const key = 'git.authorName';
    for (const ok of ['auto-swe', 'Acme Bot', 'a'.repeat(100)]) {
      expect(accepts(key, ok), ok).toBe(true);
    }
    for (const bad of ['', 'a'.repeat(101), 'a\nb', 'a\rb', 'a\u0000b', 'a<b', 'a>b', 5, null]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
    for (const bad of [' ', '   ', 'a b', 'a b', 'a‮b', 'a​b']) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
  });

  it('git.authorName rejects names git refuses to commit with (only ident crud characters)', () => {
    const key = 'git.authorName';
    for (const bad of [',;', '"', "''", '\\', '. ,', '.', ':;<', '\t ']) {
      expect(accepts(key, bad), JSON.stringify(bad)).toBe(false);
    }
    for (const ok of ["O'Brien", 'a.', '.a', 'Acme Bot', 'auto-swe']) {
      expect(accepts(key, ok), ok).toBe(true);
    }
  });

  it('git.authorEmail accepts the TLD-less default and rejects malformed values', () => {
    const key = 'git.authorEmail';
    const longest = `${'a'.repeat(245)}@acme.com`;
    expect(longest.length).toBe(254);
    for (const ok of ['auto-swe@localhost', 'bot@acme.example', longest]) {
      expect(accepts(key, ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'no-at-sign',
      'a@b@c',
      'a b@c.com',
      'a@c.com\n',
      'a\tb@c.com',
      'a<b@c.com',
      'a@c>.com',
      'a‮b@c.com',
      `a${longest}`,
      5,
    ]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
  });

  it('git.launcherAttribution accepts only the three modes', () => {
    const key = 'git.launcherAttribution';
    for (const ok of ['none', 'co-author-trailer', 'author']) {
      expect(accepts(key, ok), ok).toBe(true);
    }
    for (const bad of ['', 'trailer', 'None', true, null]) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
  });
});

describe('qodo pull-request feedback settings', () => {
  const def = SETTING_DEFINITIONS;
  const accepts = (key: keyof typeof SETTING_DEFINITIONS, value: unknown) =>
    def[key].schema.safeParse(value).success;

  it('keeps the feature inert until an admin names the bot', () => {
    const d = def['qodo.prFeedbackBotAccountIds'];
    expect(d.defaultValue).toEqual([]);
    expect(d.overridableAt).toEqual([]);
    expect(d.requiredRole).toBe('ADMIN');
    expect(def['qodo.enabled'].defaultValue).toBe(false);
  });

  it('takes up to ten positive integer account ids, and a numeric string as the form sends it', () => {
    const key = 'qodo.prFeedbackBotAccountIds';
    for (const ok of [[], [424242], ['424242'], Array.from({ length: 10 }, (_, i) => i + 1)]) {
      expect(accepts(key, ok), JSON.stringify(ok)).toBe(true);
    }
    expect(def[key].schema.parse(['424242', 7])).toEqual([424242, 7]);
    for (const bad of [
      [0],
      [-1],
      [1.5],
      ['abc'],
      [''],
      ['12 3'],
      [null],
      [true],
      Array.from({ length: 11 }, (_, i) => i + 1),
    ]) {
      expect(accepts(key, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('includes Qodo in a command round only when an admin opts in, per team or organization', () => {
    const d = def['qodo.prFeedbackIncludeOnCommand'];
    expect(d.defaultValue).toBe(false);
    expect(d.requiredRole).toBe('ADMIN');
    expect(d.overridableAt).toEqual(['TEAM', 'ORGANIZATION']);
    expect(d.runPinned).toBe(false);
    expect(d.restartRequired).toBe(false);
    expect(accepts('qodo.prFeedbackIncludeOnCommand', true)).toBe(true);
    expect(accepts('qodo.prFeedbackIncludeOnCommand', 'yes')).toBe(false);
  });

  it('bounds the rounds, the level and the wait', () => {
    expect(def['qodo.prFeedbackMaxRounds'].defaultValue).toBe(2);
    expect(def['qodo.prFeedbackMinActionLevel'].defaultValue).toBe('remediation_recommended');
    expect(def['qodo.prFeedbackWaitSeconds'].defaultValue).toBe(120);
    for (const ok of [1, 10]) {
      expect(accepts('qodo.prFeedbackMaxRounds', ok)).toBe(true);
    }
    for (const bad of [0, 11, 1.5]) {
      expect(accepts('qodo.prFeedbackMaxRounds', bad)).toBe(false);
    }
    for (const ok of ['action_required', 'remediation_recommended', 'informational']) {
      expect(accepts('qodo.prFeedbackMinActionLevel', ok)).toBe(true);
    }
    expect(accepts('qodo.prFeedbackMinActionLevel', 'unknown')).toBe(false);
    // The wait stays below the gather activity's timeout (30 min), with room to spare.
    for (const ok of [0, 600]) {
      expect(accepts('qodo.prFeedbackWaitSeconds', ok)).toBe(true);
    }
    for (const bad of [-1, 601, 900]) {
      expect(accepts('qodo.prFeedbackWaitSeconds', bad)).toBe(false);
    }
  });

  it('bounds the wait for the run that opened the pull request', () => {
    const runWait = def['qodo.prFeedbackRunWaitSeconds'];
    expect(runWait.defaultValue).toBe(900);
    expect(runWait.requiredRole).toBe('ADMIN');
    expect(runWait.overridableAt).toEqual([]);
    for (const ok of [0, 900]) {
      expect(accepts('qodo.prFeedbackRunWaitSeconds', ok)).toBe(true);
    }
    for (const bad of [-1, 901, 1.5]) {
      expect(accepts('qodo.prFeedbackRunWaitSeconds', bad)).toBe(false);
    }
  });

  it('keeps both waits and the Qodo reads inside the gather activity', () => {
    // runnableActivities.ts: `prFeedbackQodoGatherActivities` has a 30 minute start-to-close.
    const ACTIVITY_SECONDS = 1_800;
    const READ_SECONDS = 120;
    const slack = 120; // the GitHub reads around the two waits
    const max = (key: 'qodo.prFeedbackRunWaitSeconds' | 'qodo.prFeedbackWaitSeconds') =>
      (SETTING_DEFINITIONS[key].schema as z.ZodNumber).maxValue ?? Number.POSITIVE_INFINITY;
    expect(
      max('qodo.prFeedbackRunWaitSeconds') +
        max('qodo.prFeedbackWaitSeconds') +
        READ_SECONDS +
        slack
    ).toBeLessThan(ACTIVITY_SECONDS);
  });
});

describe('Jira filter polling settings', () => {
  const accepts = (key: keyof typeof SETTING_DEFINITIONS, value: unknown) =>
    SETTING_DEFINITIONS[key].schema.safeParse(value).success;

  it('the kill switch is off by default, ADMIN only, and settable per team or organization', () => {
    const def = SETTING_DEFINITIONS['workflow.jiraPollAutomationsEnabled'];
    expect(def.defaultValue).toBe(false);
    expect(def.requiredRole).toBe('ADMIN');
    expect(def.overridableAt).toEqual(['TEAM', 'ORGANIZATION']);
    expect(accepts('workflow.jiraPollAutomationsEnabled', 'yes')).toBe(false);
  });

  it('the project allowlist is empty by default and takes only Jira project keys', () => {
    const key = 'workflow.jiraPollProjectKeys';
    expect(SETTING_DEFINITIONS[key].defaultValue).toEqual([]);
    expect(SETTING_DEFINITIONS[key].requiredRole).toBe('ADMIN');
    expect(SETTING_DEFINITIONS[key].overridableAt).toEqual(['TEAM', 'ORGANIZATION']);
    expect(accepts(key, ['PAY', 'plat_eng', 'A1'])).toBe(true);
    for (const bad of [['PAY-1'], ['has space'], ['1ABC'], [''], 'PAY', [1]]) {
      expect(accepts(key, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the poll interval is global only, at least a minute, and five minutes by default', () => {
    const key = 'workflow.jiraPollIntervalSeconds';
    expect(SETTING_DEFINITIONS[key].defaultValue).toBe(300);
    expect(SETTING_DEFINITIONS[key].overridableAt).toEqual([]);
    expect(SETTING_DEFINITIONS[key].requiredRole).toBe('ADMIN');
    for (const ok of [60, 300, 86_400]) {
      expect(accepts(key, ok), String(ok)).toBe(true);
    }
    for (const bad of [59, 0, 86_401, 90.5, '300']) {
      expect(accepts(key, bad), String(bad)).toBe(false);
    }
  });
});

describe('github.trackerIssueRepositories', () => {
  const key = 'github.trackerIssueRepositories';
  const def = SETTING_DEFINITIONS[key];

  it('is empty by default, ADMIN-only, and overridable at team and organization', () => {
    expect(def.defaultValue).toEqual([]);
    expect(def.requiredRole).toBe('ADMIN');
    expect(def.overridableAt).toEqual(['TEAM', 'ORGANIZATION']);
    expect(def.group).toBe('github');
    expect(def.runPinned).toBe(false);
  });

  it('takes owner/repo entries, trimmed, and drops case-insensitive repeats', () => {
    expect(def.schema.parse([])).toEqual([]);
    expect(def.schema.parse([' Acme/Issues ', 'acme/issues', 'acme/web.v2', 'a_b/c-d'])).toEqual([
      'Acme/Issues',
      'acme/web.v2',
      'a_b/c-d',
    ]);
  });

  it.each([
    ['no slash', ['acme']],
    ['three segments', ['acme/web/extra']],
    ['an issue number', ['acme/web#1']],
    ['a dot segment', ['acme/..']],
    ['a leading dot segment', ['./web']],
    ['whitespace inside', ['ac me/web']],
    ['a URL', ['https://github.com/acme/web']],
    ['non-ASCII', ['acmé/web']],
    ['an empty entry', ['']],
    ['not a list', 'acme/web'],
    ['a non-string entry', [1]],
  ])('rejects %s', (_label, value) => {
    expect(def.schema.safeParse(value).success).toBe(false);
  });

  it('takes at most fifty repositories', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `acme/repo${i}`);
    expect(def.schema.safeParse(many(50)).success).toBe(true);
    expect(def.schema.safeParse(many(51)).success).toBe(false);
  });
});

describe('prEvaluation settings', () => {
  const accepts = (key: keyof typeof SETTING_DEFINITIONS, value: unknown) =>
    SETTING_DEFINITIONS[key].schema.safeParse(value).success;
  const keys = Object.keys(SETTING_DEFINITIONS).filter((k) =>
    k.startsWith('prEvaluation.')
  ) as (keyof typeof SETTING_DEFINITIONS)[];

  it('are all ADMIN-only, in the prEvaluation group, and not pinned to a run', () => {
    expect(keys).toHaveLength(13);
    for (const key of keys) {
      const def = SETTING_DEFINITIONS[key];
      expect(def.group, key).toBe('prEvaluation');
      expect(def.requiredRole, key).toBe('ADMIN');
      expect(def.runPinned, key).toBe(false);
      expect(def.schema.safeParse(def.defaultValue).success, key).toBe(true);
    }
  });

  it('keeps the kill switch and auto-merge off by default and GLOBAL only', () => {
    for (const key of ['prEvaluation.enabled', 'prEvaluation.autoMergeAllowed'] as const) {
      expect(SETTING_DEFINITIONS[key].defaultValue, key).toBe(false);
      expect(SETTING_DEFINITIONS[key].overridableAt, key).toEqual([]);
    }
  });

  it('refuses a default mode of auto', () => {
    expect(accepts('prEvaluation.defaultMode', 'advisory')).toBe(true);
    expect(accepts('prEvaluation.defaultMode', 'off')).toBe(true);
    expect(accepts('prEvaluation.defaultMode', 'auto')).toBe(false);
  });

  it('bounds every approver count to 1..10', () => {
    for (const key of [
      'prEvaluation.lowApprovers',
      'prEvaluation.standardApprovers',
      'prEvaluation.highApprovers',
    ] as const) {
      expect(accepts(key, 1), key).toBe(true);
      expect(accepts(key, 10), key).toBe(true);
      for (const bad of [0, -1, 11, 1.5, '1']) {
        expect(accepts(key, bad), `${key} ${String(bad)}`).toBe(false);
      }
    }
  });

  it('keeps thresholds positive integers with a ceiling', () => {
    for (const key of [
      'prEvaluation.maxLowLines',
      'prEvaluation.maxLowFiles',
      'prEvaluation.maxLowDirs',
      'prEvaluation.highLines',
      'prEvaluation.autoMinEvidence',
    ] as const) {
      expect(accepts(key, 1), key).toBe(true);
      for (const bad of [0, -5, 2.5, 100_000_000]) {
        expect(accepts(key, bad), `${key} ${bad}`).toBe(false);
      }
    }
  });

  it('bounds the sensitive path list and the status context', () => {
    expect(accepts('prEvaluation.sensitivePaths', [])).toBe(true);
    expect(accepts('prEvaluation.sensitivePaths', ['**/payments/**'])).toBe(true);
    expect(accepts('prEvaluation.sensitivePaths', [''])).toBe(false);
    expect(accepts('prEvaluation.sensitivePaths', ['x'.repeat(201)])).toBe(false);
    expect(accepts('prEvaluation.sensitivePaths', Array(101).fill('a'))).toBe(false);
    expect(accepts('prEvaluation.requiredStatusContext', 'auto-swe/pr-evaluation')).toBe(true);
    expect(accepts('prEvaluation.requiredStatusContext', '')).toBe(false);
    expect(accepts('prEvaluation.requiredStatusContext', ' x')).toBe(false);
  });
});
