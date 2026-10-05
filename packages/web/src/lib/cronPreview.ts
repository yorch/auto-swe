/**
 * Validates and reads back the cron subset the gateway accepts: five space-separated fields
 * (minute hour day-of-month month day-of-week) of numbers, `*`, ranges, steps and lists.
 * Schedules run in UTC. The preview exists so an admin sees "Weekdays at 09:00 UTC" for what
 * they typed instead of trusting five opaque fields.
 */

export type CronPreview = { ok: true; text: string } | { error: string; ok: false };

interface FieldSpec {
  label: string;
  max: number;
  min: number;
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', max: 59, min: 0 },
  { label: 'hour', max: 23, min: 0 },
  { label: 'day of month', max: 31, min: 1 },
  { label: 'month', max: 12, min: 1 },
  { label: 'day of week', max: 7, min: 0 },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_PLURALS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

interface ParsedField {
  /** Every value the field matches, ascending. */
  values: number[];
  /** True for a bare `*`. */
  any: boolean;
  // The step n of a star-slash-n field, else null.
  step: number | null;
}

function parseField(raw: string, spec: FieldSpec): ParsedField | string {
  const values = new Set<number>();
  let step: number | null = null;
  for (const part of raw.split(',')) {
    const match = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) {
      return `The ${spec.label} field "${raw}" is not valid.`;
    }
    const [, start, end, stepText] = match;
    const stepValue = stepText === undefined ? 1 : Number(stepText);
    if (stepValue < 1) {
      return `The ${spec.label} step must be at least 1.`;
    }
    let from: number;
    let to: number;
    if (start === '*') {
      if (end !== undefined) {
        return `The ${spec.label} field "${raw}" is not valid.`;
      }
      from = spec.min;
      to = spec.max;
    } else {
      from = Number(start);
      to = end === undefined ? (stepText === undefined ? from : spec.max) : Number(end);
    }
    if (from < spec.min || to > spec.max || from > to) {
      return `The ${spec.label} must be between ${spec.min} and ${spec.max}.`;
    }
    if (raw === `*/${stepText}` && stepText !== undefined) {
      step = stepValue;
    }
    for (let v = from; v <= to; v += stepValue) {
      values.add(v);
    }
  }
  // Day of week: 7 is another spelling of Sunday.
  const list = [...values].map((v) => (spec.label === 'day of week' && v === 7 ? 0 : v));
  return { any: raw === '*', step, values: [...new Set(list)].sort((a, b) => a - b) };
}

const pad = (n: number) => String(n).padStart(2, '0');

function dayPhrase(dow: ParsedField, dom: ParsedField, month: ParsedField): string {
  const parts: string[] = [];
  const dows = dow.values;
  let weekdayPhrase = '';
  if (!dow.any) {
    if (dows.join() === '1,2,3,4,5') {
      weekdayPhrase = 'weekdays';
    } else if (dows.join() === '0,6') {
      weekdayPhrase = 'weekends';
    } else if (dows.length === 1) {
      weekdayPhrase = DAY_PLURALS[dows[0]].toLowerCase();
    } else {
      weekdayPhrase = dows.map((d) => DAY_NAMES[d]).join(', ');
    }
  }
  const domPhrase = dom.any
    ? ''
    : `on day${dom.values.length === 1 ? '' : 's'} ${dom.values.join(', ')} of the month`;
  if (weekdayPhrase && domPhrase) {
    // Standard cron fires when EITHER day field matches once both are restricted.
    parts.push(`${domPhrase} or on ${weekdayPhrase}`);
  } else {
    parts.push(weekdayPhrase || domPhrase);
  }
  if (!month.any) {
    parts.push(`in ${month.values.map((m) => MONTH_NAMES[m - 1]).join(', ')}`);
  }
  return parts.filter(Boolean).join(' ');
}

/** The expression as the server expects it: trimmed, fields separated by single spaces. */
export function normalizeCron(expression: string): string {
  return expression.trim().split(/\s+/).join(' ');
}

export function describeCron(expression: string): CronPreview {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === '') {
    return {
      error: 'Use five fields: minute, hour, day of month, month, day of week.',
      ok: false,
    };
  }
  const parsed: ParsedField[] = [];
  for (let i = 0; i < 5; i++) {
    const result = parseField(fields[i], FIELDS[i]);
    if (typeof result === 'string') {
      return { error: result, ok: false };
    }
    parsed.push(result);
  }
  const [minute, hour, dom, month, dow] = parsed;
  const days = dayPhrase(dow, dom, month);

  // A fixed time of day (one or a few minute/hour pairs): "Weekdays at 09:00 UTC".
  if (!minute.any && minute.step === null && !hour.any && hour.step === null) {
    const times = hour.values.flatMap((h) => minute.values.map((m) => `${pad(h)}:${pad(m)}`));
    if (times.length <= 4) {
      const when = `at ${times.join(', ')} UTC`;
      const text = days ? `${capitalize(days)} ${when}` : `Every day ${when}`;
      return { ok: true, text };
    }
  }

  let cadence: string;
  if (minute.any && hour.any) {
    cadence = 'Every minute';
  } else if (minute.step !== null && hour.any) {
    cadence = `Every ${minute.step} minutes`;
  } else if (minute.values.length === 1 && hour.any) {
    cadence = `Every hour at minute ${minute.values[0]}`;
  } else if (minute.step !== null && !hour.any) {
    cadence = `Every ${minute.step} minutes between hours ${hour.values.join(', ')}`;
  } else {
    cadence = `At minutes ${minute.values.join(', ')} of hours ${hour.values.join(', ')}`;
  }
  return { ok: true, text: `${cadence}${days ? `, ${days} only` : ''} (UTC)` };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
