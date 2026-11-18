import { plural } from '@/lib/utils';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long until a deadline, in words: "in 7 days", not "167.99h". Under two days it counts hours,
 * so "in 36 hours" is not rounded up to a day it is not.
 */
export function formatTimeUntil(msLeft: number): string {
  if (msLeft < MINUTE) {
    return 'in under a minute';
  }
  if (msLeft < HOUR) {
    return `in ${plural(Math.round(msLeft / MINUTE), 'minute')}`;
  }
  if (msLeft < 2 * DAY) {
    return `in ${plural(Math.round(msLeft / HOUR), 'hour')}`;
  }
  return `in ${plural(Math.round(msLeft / DAY), 'day')}`;
}
