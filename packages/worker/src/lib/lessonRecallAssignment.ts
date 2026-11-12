import { createHash } from 'node:crypto';

export type RecallArm = 'ON' | 'SHADOW' | 'OFF';

export function assignLessonRecall(
  runId: string,
  pins: Record<string, unknown>
): {
  lessonRecallArm: RecallArm;
  lessonRecallHeldOut: boolean;
} {
  const mode = pins['memory.lessonRecall'];
  const percent = pins['memory.lessonHoldoutPercent'];
  const bucket =
    createHash('sha256').update(`lesson-recall:${runId}`).digest().readUInt32BE(0) / 2 ** 32;
  const heldOut =
    mode !== 'shadow' && mode !== 'off' && typeof percent === 'number' && bucket * 100 < percent;
  return {
    lessonRecallArm: mode === 'off' ? 'OFF' : mode === 'shadow' || heldOut ? 'SHADOW' : 'ON',
    lessonRecallHeldOut: heldOut,
  };
}
