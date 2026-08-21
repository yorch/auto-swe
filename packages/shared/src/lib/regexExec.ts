/**
 * Wall-clock-bounded execution of operator- and bundle-supplied regular
 * expressions.
 *
 * Scanner patterns are DATA: admins add them at `/admin/scanner`, and installed
 * bundles carry them. Their bodies are compiled with `new RegExp` and run
 * in-process against agent text (every `bash` command, every `writeFile` path,
 * every skill save, every TDD iteration's LLM output). JavaScript's backtracking
 * engine has no execution budget and a running regex cannot be interrupted from
 * the thread executing it, so a catastrophic pattern like `(a+)+$` is a
 * self-inflicted denial of service on the gateway or worker.
 *
 * Structural ("is this shaped like a ReDoS?") analysis was tried and removed: it
 * both missed real hangs and rejected ordinary linear patterns, including two of
 * this repo's own hardcoded scanner regexes. The only construction that actually
 * bounds JS regex execution is running it somewhere killable, so that is what
 * this does — a single long-lived `worker_thread` that owns all pattern
 * execution and is `terminate()`d when it overruns its budget.
 *
 * Properties:
 *
 * - **One pooled worker.** Spawn costs ~70 ms once; a warm round trip is ~0.1 ms,
 *   which is noise next to the Docker exec or LLM call every call site already
 *   pays. Batches are serialised through the worker so a wedged batch never
 *   corrupts a concurrent one.
 * - **Compiled-pattern cache inside the worker.** The worker keeps its own
 *   `Map<identity, RegExp>` so a pattern is compiled once per process, not once
 *   per batch — every `bash` call and `writeFile` re-sends the same 58+
 *   built-in patterns otherwise. Keyed on the source+flags identity string
 *   only; the worker never holds a caller's pattern/target objects between
 *   jobs.
 * - **Attribution by bisection.** On an overrun the worker is terminated and the
 *   batch is re-run in halves against a fresh worker, so the specific pattern
 *   that hung is identified and the results of the well-behaved patterns are
 *   still returned. This costs a handful of extra spawns, and only on the
 *   failure path.
 * - **Quarantine.** A pattern that overruns is added to a process-local
 *   quarantine set and skipped by subsequent batches, so one bad row cannot
 *   permanently deny agent shell access. See the limitation note below.
 * - **Never throws.** A scan must never abort the calling activity, so every
 *   failure mode resolves to a result with `incomplete: true` and the caller
 *   decides (blocking scanners fail closed; advisory ones degrade to a warning).
 *
 * Residual risk, stated plainly:
 *
 * - Quarantine is **fail-open for the quarantined rule**. The scan during which
 *   a pattern overran fails closed, but every later scan silently proceeds
 *   without that rule (loudly logged each time). The alternative — refusing
 *   every scan forever — turns one bad admin pattern into a total outage.
 * - The quarantine set is per-process and per-lifetime; gateway and worker
 *   quarantine independently and both forget on restart.
 * - A pattern can still burn a full budget per scan before being quarantined,
 *   and quarantine is keyed on pattern source, so N distinct bad patterns cost
 *   N budgets. This bounds a hang; it does not make scanning free.
 */

import { Worker } from 'node:worker_threads';
import { resolveSetting } from '../config/resolveSetting.js';

/**
 * Default per-batch wall-clock budget — the value the `workspace.regexScanBudgetMs`
 * setting falls back to when nothing overrides it, so it stays the effective
 * budget for an unconfigured deployment and is what {@link runRegexBatch} uses
 * when a caller omits `opts.budgetMs` (as the tests in this file do, to exercise
 * a fixed bound). The four scanner entry points must not rely on that implicit
 * default, though: they call {@link resolveRegexBudgetMs} to get the *live*
 * value and pass it explicitly, so an operator's override actually takes effect.
 */
export const DEFAULT_REGEX_BUDGET_MS = 250;

/**
 * Resolves the operator-tunable `workspace.regexScanBudgetMs` setting for one
 * scan invocation. This is the ONLY runtime way callers should learn the
 * effective budget — per AGENTS.md's setting-registry convention, nothing
 * downstream of this module should hold its own module-scope budget constant.
 *
 * Callers are the scanner entry points (`skillScanner.ts`,
 * `shellCommandScanner.ts`, `sensitiveFileScanner.ts`, `codeSecurityScanner.ts`),
 * each resolving once per scan and threading the result through
 * `runRegexBatch`'s `opts.budgetMs` — not a DB round trip per pattern, since
 * `resolveSetting` sits behind the shared ~30s config cache.
 *
 * A scan must never throw into its calling activity, so this never rejects:
 * any resolution failure (DB down, cache miss racing a pool hiccup, whatever)
 * falls back to {@link DEFAULT_REGEX_BUDGET_MS} rather than propagating.
 */
export async function resolveRegexBudgetMs(): Promise<number> {
  try {
    return await resolveSetting('workspace.regexScanBudgetMs');
  } catch (err) {
    console.error(
      '[regexExec] could not resolve workspace.regexScanBudgetMs; falling back to the default ' +
        `of ${DEFAULT_REGEX_BUDGET_MS}ms:`,
      err
    );
    return DEFAULT_REGEX_BUDGET_MS;
  }
}

/** A pattern to run. `key` is only used to report results; identity is source+flags. */
export interface RegexSpec {
  key: string;
  source: string;
  flags: string;
}

/**
 * Shape shared by every scanner's stored-pattern cache (`makePatternLoader`'s
 * `CachedEntry`, `skillScanner`'s local `PatternEntry`, …) — a pattern kept as
 * label + source + flags, with execution deferred to this module.
 */
export interface RegexPatternEntry {
  label: string;
  source: string;
  flags: string;
}

/**
 * Adapts loaded scanner patterns into {@link RegexSpec}s for {@link runRegexBatch}.
 * `keyPrefix` distinguishes categories sharing one batch (e.g. `'injection:'` vs
 * `'exfiltration:'`) — pass the full prefix, colon included.
 */
export function toRegexSpecs(entries: RegexPatternEntry[], keyPrefix = ''): RegexSpec[] {
  return entries.map((p) => ({
    flags: p.flags,
    key: `${keyPrefix}${p.label}`,
    source: p.source,
  }));
}

/** A string to run the patterns against. */
export interface RegexTarget {
  key: string;
  text: string;
}

export interface RegexHit {
  patternKey: string;
  targetKey: string;
  match: string;
}

export interface RegexBatchResult {
  hits: RegexHit[];
  /**
   * True when at least one pattern could not be evaluated — it overran the
   * budget, or the executor itself failed. Blocking scanners MUST treat this as
   * "cannot clear" and block; advisory scanners degrade to a warning.
   */
  incomplete: boolean;
  /** Keys of patterns that individually overran the budget on this batch. */
  timedOutPatternKeys: string[];
  /** Keys skipped because an earlier batch quarantined their source. */
  quarantinedPatternKeys: string[];
}

// The worker body is passed as a string (`eval: true`) rather than a file so it
// needs no build step, no module resolution, and no loader — it behaves
// identically under tsx, vitest, and the compiled dist output. Keep it dependency
// free and keep `${` out of it: it lives inside a template literal.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
// Compiled RegExp objects, keyed by the same "flags source" identity string the
// quarantine logic uses. Keyed by that STRING only — the worker never retains a
// caller-supplied pattern/target array between jobs, only what it compiled from
// one, so a spent job's objects are eligible for GC as soon as the job returns.
const compiled = new Map();
function getCompiled(source, flags) {
  const identity = flags + ' ' + source;
  if (compiled.has(identity)) {
    return compiled.get(identity);
  }
  let re;
  try {
    re = new RegExp(source, flags);
  } catch {
    re = null;
  }
  compiled.set(identity, re);
  return re;
}
parentPort.on('message', (job) => {
  const hits = [];
  for (const p of job.patterns) {
    const re = getCompiled(p.source, p.flags);
    if (!re) {
      continue;
    }
    for (const t of job.targets) {
      re.lastIndex = 0;
      const m = re.exec(t.text);
      if (m) {
        hits.push({ match: m[0], patternKey: p.key, targetKey: t.key });
      }
    }
  }
  parentPort.postMessage({ hits });
});
`;

let worker: Worker | null = null;
/** Resolves true once the thread is executing, false if it died starting up. */
let workerReady: Promise<boolean> | null = null;
/** Serialises batches: one in flight at a time on the shared worker. */
let queue: Promise<unknown> = Promise.resolve();
/** Pattern sources (`flags\x00source`) that overran and are now skipped. */
const quarantine = new Set<string>();

function identity(source: string, flags: string): string {
  return `${flags}\x00${source}`;
}

function getWorker(): Worker | null {
  if (worker) {
    return worker;
  }
  try {
    const next = new Worker(WORKER_SOURCE, { eval: true });
    // Never hold the process open: a pending batch is kept alive by its own
    // budget timer, and an idle executor must not block a clean exit.
    next.unref();
    next.on('error', () => {
      if (worker === next) {
        worker = null;
      }
    });
    // Starting a thread is not regex execution. Charging spawn to the budget
    // would fail the first scan of every process closed on a busy host — a
    // spurious block on the agent's first `bash` call, not a real overrun.
    workerReady = new Promise<boolean>((resolve) => {
      next.once('online', () => resolve(true));
      next.once('error', () => resolve(false));
      next.once('exit', () => resolve(false));
    });
    worker = next;
    return next;
  } catch (err) {
    console.error('[regexExec] could not start the regex executor thread:', err);
    return null;
  }
}

function killWorker(): void {
  const dying = worker;
  worker = null;
  workerReady = null;
  void dying?.terminate();
}

type RunOutcome =
  | { ok: true; hits: RegexHit[] }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'fault' };

/** One round trip to the worker, bounded by `budgetMs`. Never rejects. */
async function runOnce(
  patterns: RegexSpec[],
  targets: RegexTarget[],
  budgetMs: number
): Promise<RunOutcome> {
  const w = getWorker();
  if (!w) {
    return { ok: false, reason: 'fault' };
  }
  // Wait out the spawn before the clock starts. Already-online threads resolve
  // on the next microtask, so the warm path is unchanged.
  if (workerReady && !(await workerReady)) {
    return { ok: false, reason: 'fault' };
  }
  if (worker !== w) {
    // Terminated while we waited — the caller retries against a fresh thread.
    return { ok: false, reason: 'fault' };
  }
  return new Promise<RunOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: RunOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      w.off('message', onMessage);
      w.off('error', onFault);
      w.off('exit', onFault);
      resolve(outcome);
    };
    const onMessage = (msg: { hits: RegexHit[] }) => finish({ hits: msg.hits, ok: true });
    const onFault = () => {
      killWorker();
      finish({ ok: false, reason: 'fault' });
    };
    const timer = setTimeout(() => {
      // The worker is stuck inside a regex and will never yield; the only way
      // out is to destroy the thread.
      killWorker();
      finish({ ok: false, reason: 'timeout' });
    }, budgetMs);

    w.on('message', onMessage);
    w.on('error', onFault);
    w.on('exit', onFault);
    try {
      w.postMessage({ patterns, targets });
    } catch {
      onFault();
    }
  });
}

const EMPTY: RegexBatchResult = {
  hits: [],
  incomplete: false,
  quarantinedPatternKeys: [],
  timedOutPatternKeys: [],
};

/** Bisect a batch that overran to find which pattern(s) actually hang. */
async function evaluate(
  patterns: RegexSpec[],
  targets: RegexTarget[],
  budgetMs: number
): Promise<RegexBatchResult> {
  if (patterns.length === 0) {
    return EMPTY;
  }
  const outcome = await runOnce(patterns, targets, budgetMs);
  if (outcome.ok) {
    return { ...EMPTY, hits: outcome.hits };
  }
  if (outcome.reason === 'fault' || patterns.length === 1) {
    // A single pattern that overruns is the culprit; a fault is not attributable
    // to any pattern, so nothing is quarantined for it.
    const timedOut = outcome.reason === 'timeout' ? patterns.map((p) => p.key) : [];
    return { ...EMPTY, incomplete: true, timedOutPatternKeys: timedOut };
  }
  // Sequentially — the halves share one worker, so overlapping them would both
  // interleave their replies and blame the innocent half for the other's hang.
  const mid = Math.floor(patterns.length / 2);
  const a = await evaluate(patterns.slice(0, mid), targets, budgetMs);
  const b = await evaluate(patterns.slice(mid), targets, budgetMs);
  return {
    hits: [...a.hits, ...b.hits],
    incomplete: true,
    quarantinedPatternKeys: [],
    timedOutPatternKeys: [...a.timedOutPatternKeys, ...b.timedOutPatternKeys],
  };
}

/**
 * Run `patterns` against `targets` under a wall-clock budget.
 *
 * Resolves — never rejects. Inspect {@link RegexBatchResult.incomplete} to
 * decide whether the scan can be trusted.
 */
export async function runRegexBatch(
  patterns: RegexSpec[],
  targets: RegexTarget[],
  opts: { budgetMs?: number; label?: string } = {}
): Promise<RegexBatchResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_REGEX_BUDGET_MS;
  const scope = opts.label ?? 'regexExec';
  const runnable: RegexSpec[] = [];
  const skipped: string[] = [];
  for (const p of patterns) {
    if (quarantine.has(identity(p.source, p.flags))) {
      skipped.push(p.key);
    } else {
      runnable.push(p);
    }
  }
  if (skipped.length > 0) {
    console.error(
      `[${scope}] skipping quarantined pattern(s) — they exceeded the ${budgetMs}ms ` +
        `execution budget and are NOT being enforced: ${skipped.join(', ')}`
    );
  }
  if (runnable.length === 0 || targets.length === 0) {
    return { ...EMPTY, quarantinedPatternKeys: skipped };
  }

  const result = await enqueue(() => evaluate(runnable, targets, budgetMs));

  for (const key of result.timedOutPatternKeys) {
    const spec = runnable.find((p) => p.key === key);
    if (spec) {
      quarantine.add(identity(spec.source, spec.flags));
    }
  }
  if (result.timedOutPatternKeys.length > 0) {
    console.error(
      `[${scope}] pattern(s) exceeded the ${budgetMs}ms execution budget and were ` +
        `quarantined for this process: ${result.timedOutPatternKeys.join(', ')}`
    );
  }
  return { ...result, quarantinedPatternKeys: skipped };
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Adversarial inputs used by {@link probeRegexBacktracking}.
 *
 * Exponential blow-up needs input the pattern's own quantifiers can chew on, so
 * the seed set is a general alphabet PLUS every character the pattern itself
 * mentions — that is what makes `(w+)+$` and `([Ѐ-ӿ]+)+$` probe-detectable
 * without any structural understanding of the source.
 */
const PROBE_ALPHABET = [...'abz019 \t_-./\\:;,@#$%&=!'];
const PROBE_SUFFIXES = ['', '!', 'X', ' '];
/**
 * Repetition counts. Deliberately SHORT: exponential backtracking is already
 * unbearable at ~30 characters, while a merely quadratic pattern (`(?:\w+\.)+\w+`
 * on a dotless string) stays in microseconds there. Probing with long inputs
 * would conflate the two and reject ordinary patterns — which is exactly how the
 * structural analyser this replaced became a production liability.
 */
const PROBE_LENGTHS = [28, 44, 64];
const MAX_PROBE_SEEDS = 40;

function probeCorpus(source: string): RegexTarget[] {
  const seeds = new Set(PROBE_ALPHABET);
  for (const ch of source) {
    if (seeds.size >= MAX_PROBE_SEEDS) {
      break;
    }
    if (!/\s/.test(ch)) {
      seeds.add(ch);
    }
  }
  // Two-character cycles as well as single characters, so a group whose
  // ambiguity needs more than one distinct symbol (`(ab|a)+`) is reachable.
  const single = [...seeds];
  const units = [...single, ...single.map((c, i) => c + single[(i + 1) % single.length])];
  const targets: RegexTarget[] = [];
  let n = 0;
  for (const unit of units) {
    for (const len of PROBE_LENGTHS) {
      for (const suffix of PROBE_SUFFIXES) {
        targets.push({ key: String(n++), text: unit.repeat(len) + suffix });
      }
    }
  }
  return targets;
}

/**
 * Empirically probe a candidate pattern for catastrophic backtracking by
 * actually running it, under the executor's budget, against a corpus of
 * repetition-heavy strings built from its own alphabet.
 *
 * Returns a rejection message when the pattern overruns, or `null`.
 *
 * This is a *sound* rejection — a pattern only fails if it demonstrably burned
 * the budget — but it is far from complete: it will miss a blow-up that needs
 * input structure the corpus does not contain (an alternation of specific
 * words, a Unicode property class whose characters are not in the source), and
 * it will miss polynomial patterns whose cost only shows at inputs larger than
 * the corpus. Runtime bounding, not this probe, is the containment; the probe
 * exists so an admin gets an immediate error instead of a silently dead rule.
 */
export async function probeRegexBacktracking(
  source: string,
  flags = '',
  opts: { budgetMs?: number } = {}
): Promise<string | null> {
  const budgetMs = opts.budgetMs ?? DEFAULT_REGEX_BUDGET_MS;
  // `g`/`y` are stateful across `exec` calls; strip them so the probe measures
  // the pattern, not `lastIndex` bookkeeping.
  const safeFlags = flags.replace(/[gy]/g, '');
  const result = await enqueue(() =>
    evaluate([{ flags: safeFlags, key: 'probe', source }], probeCorpus(source), budgetMs)
  );
  if (!result.incomplete) {
    return null;
  }
  if (result.timedOutPatternKeys.length === 0) {
    // Executor fault, not a verdict on the pattern — do not reject the write.
    return null;
  }
  return (
    `pattern exceeded a ${budgetMs}ms execution budget on repetitive input, which means ` +
    'it backtracks catastrophically. Rewrite it so no quantifier is nested inside ' +
    'another repetition (e.g. `(a+)+` → `a+`) and repeated alternation branches ' +
    'cannot match the same text.'
  );
}

/** Test seam: drop the quarantine set and the pooled worker. */
export function resetRegexExecutor(): void {
  quarantine.clear();
  killWorker();
}

/** True when this exact pattern source has been quarantined in this process. */
export function isRegexQuarantined(source: string, flags = ''): boolean {
  return quarantine.has(identity(source, flags));
}
