import { describe, expect, it } from 'vitest';
import { isViewOnlyFor } from './repoLaunch';

const t = (id: string) => ({ id, name: id, slug: id });
const mine = new Set(['pay']);

describe('isViewOnlyFor', () => {
  const shared = (canLaunch: boolean) => ({
    shares: [{ canLaunch, team: t('pay') }],
    team: t('own'),
  });

  it('is view only when every share reaching the caller forbids launching', () => {
    expect(isViewOnlyFor(shared(false), mine, false)).toBe(true);
    expect(isViewOnlyFor(shared(true), mine, false)).toBe(false);
  });
  it('treats a missing canLaunch as allowed', () => {
    expect(isViewOnlyFor({ shares: [{ team: t('pay') }], team: t('own') }, mine, false)).toBe(
      false
    );
  });
  it('is never view only for the owning team, a platform admin, or while teams load', () => {
    expect(
      isViewOnlyFor({ shares: [{ canLaunch: false, team: t('pay') }], team: t('pay') }, mine, false)
    ).toBe(false);
    expect(isViewOnlyFor(shared(false), mine, true)).toBe(false);
    expect(isViewOnlyFor(shared(false), null, false)).toBe(false);
  });
  it('lets a second team that may launch win', () => {
    const repo = {
      shares: [
        { canLaunch: false, team: t('pay') },
        { canLaunch: true, team: t('data') },
      ],
      team: t('own'),
    };
    expect(isViewOnlyFor(repo, new Set(['pay', 'data']), false)).toBe(false);
    expect(isViewOnlyFor(repo, mine, false)).toBe(true);
  });
  it('is not view only for a repository the caller reaches through no share', () => {
    expect(isViewOnlyFor({ shares: [], team: t('own') }, mine, false)).toBe(false);
  });
});
