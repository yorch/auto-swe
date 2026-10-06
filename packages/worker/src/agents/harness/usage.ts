import type { ImplementerTurnOutcome } from '../implementerRuntime.js';

export type SpentByModel = NonNullable<ImplementerTurnOutcome['usageByModel']>;

/**
 * Turns what a harness reports about usage into what one turn spent, per model,
 * priced at each model's own `<provider>/<model>` spec. Stateful: one normaliser
 * serves one runtime, and is handed each report exactly once.
 */
export interface UsageNormaliser<Report> {
  normalise(report: Report): SpentByModel;
}

/** One model's usage counters, cache traffic apart from fresh input. */
export interface UsageTotals {
  /** Input served from the prompt cache. */
  cacheRead: number;
  /** Input written to the prompt cache. */
  cacheWrite: number;
  /** Input not served from or written to the cache. */
  input: number;
  output: number;
}

const ZERO: UsageTotals = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

/**
 * For a harness that reports usage per model as running totals, and resumes a
 * session from its saved totals: what a turn spent is the change since the last
 * report. A total that went backwards means the harness reset it, so it counts
 * whole.
 *
 * Cache reads and writes are input the run was billed for, so they count in the
 * input total the budget meters; they are also reported apart so pricing can
 * apply the cache rates instead of the full input price. Largest spender first.
 */
export function runningTotalsUsage(
  providerPrefix: string
): UsageNormaliser<Record<string, UsageTotals>> {
  const reported = new Map<string, UsageTotals>();
  return {
    normalise(report) {
      const spent: SpentByModel = [];
      for (const [model, u] of Object.entries(report)) {
        const total: UsageTotals = { ...u, input: u.input + u.cacheRead + u.cacheWrite };
        const before = reported.get(model) ?? ZERO;
        reported.set(model, total);
        const reset =
          total.input < before.input ||
          total.output < before.output ||
          total.cacheRead < before.cacheRead ||
          total.cacheWrite < before.cacheWrite;
        const delta = (k: keyof UsageTotals) => (reset ? total[k] : total[k] - before[k]);
        const input = delta('input');
        const output = delta('output');
        if (input > 0 || output > 0) {
          spent.push({
            modelSpec: `${providerPrefix}${model}`,
            usage: {
              cacheCreationInputTokens: delta('cacheWrite'),
              cachedInputTokens: delta('cacheRead'),
              inputTokens: input,
              outputTokens: output,
            },
          });
        }
      }
      return spent.sort((a, b) => (b.usage.outputTokens ?? 0) - (a.usage.outputTokens ?? 0));
    },
  };
}

/**
 * `total` less what was already accrued, per model and counter, never below
 * zero: what a turn still owes once some of it was debited call by call
 * (`onCallSpent`). A model left with no input and no output drops out.
 */
export function subtractSpent(total: SpentByModel, accrued: SpentByModel): SpentByModel {
  const done = new Map<
    string,
    {
      cacheCreationInputTokens: number;
      cachedInputTokens: number;
      inputTokens: number;
      outputTokens: number;
    }
  >();
  for (const { modelSpec, usage } of accrued) {
    const d = done.get(modelSpec) ?? {
      cacheCreationInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    d.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    d.cachedInputTokens += usage.cachedInputTokens ?? 0;
    d.inputTokens += usage.inputTokens ?? 0;
    d.outputTokens += usage.outputTokens ?? 0;
    done.set(modelSpec, d);
  }
  const left = (n: number | undefined, less: number) => Math.max(0, (n ?? 0) - less);
  return total
    .map(({ modelSpec, usage }) => {
      const d = done.get(modelSpec);
      return d
        ? {
            modelSpec,
            usage: {
              cacheCreationInputTokens: left(
                usage.cacheCreationInputTokens,
                d.cacheCreationInputTokens
              ),
              cachedInputTokens: left(usage.cachedInputTokens, d.cachedInputTokens),
              inputTokens: left(usage.inputTokens, d.inputTokens),
              outputTokens: left(usage.outputTokens, d.outputTokens),
            },
          }
        : { modelSpec, usage };
    })
    .filter(({ usage }) => (usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0);
}

/**
 * What a turn spent, summed from per-call usage reports (`model` → that call's
 * counters), for a turn that never reached the harness's own totals: it was
 * stopped, or its process died. Stateless, and does not move the running
 * totals {@link runningTotalsUsage} keeps. Calls the harness made without
 * reporting one are not seen, so this undercounts; it is the fallback, not the
 * meter. Largest spender first.
 */
export function summedCallsUsage(
  providerPrefix: string,
  calls: Iterable<{ model: string; usage: UsageTotals }>
): SpentByModel {
  const byModel = new Map<string, UsageTotals>();
  for (const { model, usage } of calls) {
    const t = byModel.get(model) ?? { ...ZERO };
    t.cacheRead += usage.cacheRead;
    t.cacheWrite += usage.cacheWrite;
    t.input += usage.input + usage.cacheRead + usage.cacheWrite;
    t.output += usage.output;
    byModel.set(model, t);
  }
  return [...byModel.entries()]
    .filter(([, t]) => t.input > 0 || t.output > 0)
    .map(([model, t]) => ({
      modelSpec: `${providerPrefix}${model}`,
      usage: {
        cacheCreationInputTokens: t.cacheWrite,
        cachedInputTokens: t.cacheRead,
        inputTokens: t.input,
        outputTokens: t.output,
      },
    }))
    .sort((a, b) => (b.usage.outputTokens ?? 0) - (a.usage.outputTokens ?? 0));
}
