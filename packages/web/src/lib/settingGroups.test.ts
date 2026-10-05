import { SETTING_GROUPS } from '@auto-swe/shared/config/types';
import { describe, expect, it } from 'vitest';
import { GROUP_BLURBS, GROUP_TITLES } from './settingGroups';

describe('setting groups', () => {
  it.each([...SETTING_GROUPS])('%s has a title and a blurb', (group) => {
    expect(GROUP_TITLES[group]).toBeTruthy();
    expect(GROUP_BLURBS[group]).toBeTruthy();
  });
});
