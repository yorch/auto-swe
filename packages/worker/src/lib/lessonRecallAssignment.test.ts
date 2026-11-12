import { describe, expect, it } from 'vitest';
import { assignLessonRecall } from './lessonRecallAssignment.js';

describe('assignLessonRecall', () => {
  it('keeps default and legacy snapshots on and never marks configured shadow/off as held out', () => {
    expect(assignLessonRecall('run', {})).toEqual({
      lessonRecallArm: 'ON',
      lessonRecallHeldOut: false,
    });
    for (const mode of ['shadow', 'off']) {
      expect(
        assignLessonRecall('run', {
          'memory.lessonHoldoutPercent': 50,
          'memory.lessonRecall': mode,
        })
      ).toEqual({ lessonRecallArm: mode.toUpperCase(), lessonRecallHeldOut: false });
    }
  });
  it('is deterministic, monotonic with percentage, and distributes the configured percentage', () => {
    let previous = new Set<string>();
    for (const percent of [0, 1, 10, 25, 50]) {
      const heldOut = new Set<string>();
      for (let index = 0; index < 10000; index++) {
        const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        const pins = { 'memory.lessonHoldoutPercent': percent, 'memory.lessonRecall': 'on' };
        const first = assignLessonRecall(id, pins);
        expect(assignLessonRecall(id, pins)).toEqual(first);
        if (first.lessonRecallHeldOut) {
          heldOut.add(id);
          expect(first.lessonRecallArm).toBe('SHADOW');
        } else {
          expect(first.lessonRecallArm).toBe('ON');
        }
      }
      for (const id of previous) {
        expect(heldOut.has(id)).toBe(true);
      }
      expect(Math.abs(heldOut.size / 100 - percent)).toBeLessThan(1);
      previous = heldOut;
    }
  });
});
