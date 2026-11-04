/**
 * A small preview of a 5-field cron expression, evaluated in UTC like the scheduler does: a
 * plain-words summary for the common shapes, and the next few fire times. It exists so a typo that
 * turns a weekly run into an every-minute run is visible before saving. The gateway and the
 * scheduler stay the authority on what is valid.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
interface Field {
  /** Allowed values. */
  values: Set<number>;
}

function parseField(raw: string, min: number, max: number, wrapSeven = false): Field | null {
  const values = new Set<number>();
  const num = (text: string): number | null => (/^\d+$/.test(text) ? Number(text) : null);
  for (const part of raw.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || range === undefined || range === '') {
      return null;
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      return null;
    }
    let lo: number | null;
    let hi: number | null;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || a === undefined || b === undefined) {
        return null;
      }
      lo = num(a);
      hi = num(b);
    } else {
      lo = num(range);
      hi = stepText === undefined ? lo : max;
    }
    const top = wrapSeven ? max + 1 : max;
    if (lo === null || hi === null || lo < min || hi > top || lo > hi) {
      return null;
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(wrapSeven && v === 7 ? 0 : v);
    }
  }
  return { values };
}

export interface CronPreview {
  /** Plain words for the common shapes; null for anything more involved. */
  summary: string | null;
  /** The next fire times, soonest first (up to three). */
  next: Date[];
  /** True when two consecutive fires are less than an hour apart. */
  subHourly: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

function summarise(parts: string[]): string | null {
  const [minute, hour, dom, month, dow] = parts;
  if (!/^\d+$/.test(minute ?? '') || !/^\d+$/.test(hour ?? '') || dom !== '*' || month !== '*') {
    return null;
  }
  const at = `${pad(Number(hour))}:${pad(Number(minute))} UTC`;
  if (dow === '*') {
    return `Every day at ${at}`;
  }
  if (/^[0-7]$/.test(dow ?? '')) {
    return `Every ${DAY_NAMES[Number(dow) % 7]} at ${at}`;
  }
  return null;
}

/** `null` when the expression is not a valid 5-field cron expression. */
export function previewCron(expression: string, from: Date = new Date()): CronPreview | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }
  const minute = parseField(parts[0] ?? '', 0, 59);
  const hour = parseField(parts[1] ?? '', 0, 23);
  const dom = parseField(parts[2] ?? '', 1, 31);
  const month = parseField(parts[3] ?? '', 1, 12);
  const dow = parseField(parts[4] ?? '', 0, 6, true);
  if (!minute || !hour || !dom || !month || !dow) {
    return null;
  }

  const matchesDay = (d: Date): boolean => {
    const domOk = dom.values.has(d.getUTCDate());
    const dowOk = dow.values.has(d.getUTCDay());
    // Temporal Schedules require both day fields to match; the classic cron "either" rule is not
    // implemented there.
    return domOk && dowOk;
  };

  const next: Date[] = [];
  // Start at the next whole minute and look up to 400 days ahead.
  const start = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    from.getUTCHours(),
    from.getUTCMinutes() + 1
  );
  const limit = start + 400 * 24 * 60 * 60 * 1000;
  for (let t = start; t < limit && next.length < 3; t += 60_000) {
    const d = new Date(t);
    // Skip whole hours and days quickly when they cannot match.
    if (!month.values.has(d.getUTCMonth() + 1) || !matchesDay(d)) {
      t += (24 * 60 - d.getUTCHours() * 60 - d.getUTCMinutes()) * 60_000 - 60_000;
      continue;
    }
    if (!hour.values.has(d.getUTCHours())) {
      t += (60 - d.getUTCMinutes()) * 60_000 - 60_000;
      continue;
    }
    if (minute.values.has(d.getUTCMinutes())) {
      next.push(d);
    }
  }
  const subHourly =
    next.length >= 2 && (next[1] as Date).getTime() - (next[0] as Date).getTime() < 3_600_000;
  return { next, subHourly, summary: summarise(parts) };
}
