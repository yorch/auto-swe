import { describe, expect, it } from 'vitest';
import { handLaunchBlock } from './channelTask.js';

describe('handLaunchBlock', () => {
  it.each([null, undefined])('allows ordinary templates with kind %s', (kind) => {
    expect(handLaunchBlock({ kind, name: 'hotfix', team: null })).toBeNull();
  });
  it.each([
    ['review', "Started from a finished run's Reviews panel"],
    ['automation', 'Started by an automation or integration'],
  ])('explains %s launches', (kind, reason) => {
    expect(handLaunchBlock({ kind, name: 'template', team: null })).toEqual({ reason });
  });
  it('blocks only the global system-managed shell', () => {
    expect(handLaunchBlock({ name: 'Channel Assistant', team: null })?.reason).toBe(
      'Started automatically by the platform'
    );
    expect(handLaunchBlock({ name: 'Channel Assistant', team: { id: 'team' } })).toBeNull();
  });
});
