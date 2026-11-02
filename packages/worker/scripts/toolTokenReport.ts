/**
 * Where did the implementer's input tokens go? Reads recorded agent transcripts
 * (every model request, with the provider's own usage) and prints, per runtime
 * and model, each kind of prompt content as a share of input tokens and of
 * input cost.
 *
 *   yarn workspace @auto-swe/worker exec tsx --env-file=../../.env \
 *     scripts/toolTokenReport.ts <runId>
 *   yarn workspace @auto-swe/worker exec tsx --env-file=../../.env \
 *     scripts/toolTokenReport.ts --days 7 --limit 50
 *
 * `--cache-read-rate <x>` prices cached input at x times the plain input price for a
 * model the price table has no cache rate for (it then reports no discount, so cost
 * equals tokens). The rate used and where it came from are printed per model.
 *
 * Read-only, and prints aggregates only — no transcript text. It reads the
 * database and artifact store directly, so it is for an operator with that
 * access; it does not write the transcript access log the gateway's reads do.
 * Only `complete` transcripts are read: a truncated one loses its last parts,
 * which are the largest prompts, and would bias the shares.
 *
 * Limits: the chars-to-tokens split is proportional, so a share is an estimate
 * of the real total, not a tokenizer count. A harness session-file record is not
 * attributable and is counted as unmeasurable.
 * The attribution is in `src/lib/toolTokenAttribution.ts`.
 */
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { prisma } from '@auto-swe/shared/db';
import { getArtifact } from '@auto-swe/shared/lib/artifactStore';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  type NormalizedCall,
  normalizeTranscriptRecord,
} from '@auto-swe/shared/lib/transcripts/normalize';
import { getCacheMultipliers } from '../src/lib/costTracking.js';
import { IMPLEMENTER_ACTIVITY_TYPES } from '../src/lib/lessonTranscriptEvidence.js';
import {
  attributeCallContext,
  type CacheRates,
  SpendReport,
} from '../src/lib/toolTokenAttribution.js';

const gunzipAsync = promisify(gunzip);

function parseArgs(argv: string[]): {
  runId?: string;
  days: number;
  limit: number;
  cacheReadRate?: number;
} {
  let runId: string | undefined;
  let days = 7;
  let limit = 50;
  let cacheReadRate: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--days' || arg === '--limit' || arg === '--cache-read-rate') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0 || (arg === '--cache-read-rate' && value > 1)) {
        throw new Error(
          arg === '--cache-read-rate'
            ? '--cache-read-rate takes a number above 0 and at most 1'
            : `${arg} takes a positive number`
        );
      }
      if (arg === '--days') {
        days = value;
      } else if (arg === '--limit') {
        limit = value;
      } else {
        cacheReadRate = value;
      }
    } else if (arg.startsWith('--') || runId !== undefined) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      runId = arg;
    }
  }
  return { cacheReadRate, days, limit, runId };
}

const { runId, days, limit, cacheReadRate } = parseArgs(process.argv.slice(2));

// The price table keys on `<provider>/<model>`; a transcript records the provider's own name for the model.
const SPEC_PROVIDER: Partial<Record<NormalizedCall['provider'], string>> = {
  anthropic: 'anthropic',
  google: 'google',
  'openai-chat': 'openai',
  'openai-responses': 'openai',
};

interface RateChoice {
  rates: CacheRates;
  source: string;
}
const rateCache = new Map<string, RateChoice>();
async function ratesFor(call: NormalizedCall): Promise<RateChoice> {
  const provider = SPEC_PROVIDER[call.provider];
  const key = `${provider ?? call.provider}/${call.model ?? ''}`;
  const seen = rateCache.get(key);
  if (seen) {
    return seen;
  }
  // No known discount: cached input is costed as plain input, so cost share equals token share.
  let choice: RateChoice = { rates: { read: 1, write: 1 }, source: 'none known' };
  if (provider && call.model) {
    try {
      const m = await getCacheMultipliers(key);
      if (m.read !== 1 || m.write !== 1) {
        choice = { rates: { read: m.read, write: m.write }, source: 'price table' };
      }
    } catch {
      // keep the neutral rates
    }
  }
  if (choice.source === 'none known' && cacheReadRate !== undefined) {
    choice = { rates: { read: cacheReadRate, write: 1 }, source: '--cache-read-rate' };
  }
  rateCache.set(key, choice);
  return choice;
}

const rows = await runUnscoped(
  'operator report over recorded transcripts',
  ['AgentTranscript'],
  () =>
    prisma.agentTranscript.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, runtime: true },
      take: limit,
      where: {
        activityType: { in: [...IMPLEMENTER_ACTIVITY_TYPES] },
        status: 'complete',
        ...(runId
          ? { runId }
          : { createdAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } }),
      },
    })
);

// One report per runtime and model: a report's cost column is in units of one model's input price.
const reports = new Map<string, SpendReport>();
const rateNotes = new Map<string, string>();
let read = 0;
let unreadable = 0;

for (const row of rows) {
  const parts = await prisma.agentTranscriptPart.findMany({
    orderBy: { seq: 'asc' },
    select: { artifactId: true, sha256: true },
    where: { transcriptId: row.id },
  });
  const staged: { key: string; attribution: ReturnType<typeof attributeCallContext> }[] = [];
  let ok = true;
  for (const part of parts) {
    const { body } = await getArtifact(part.artifactId);
    if (createHash('sha256').update(body).digest('hex') !== part.sha256) {
      ok = false;
      break;
    }
    const text = (await gunzipAsync(body)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // a line that is not a record
      }
      const call =
        record && typeof record === 'object' ? normalizeTranscriptRecord(record as never) : null;
      if (call) {
        const { rates, source } = await ratesFor(call);
        const key = `${row.runtime} / ${call.model ?? 'unknown model'}`;
        rateNotes.set(key, `cache read x${rates.read} (${source})`);
        staged.push({ attribution: attributeCallContext(call, rates), key });
      }
    }
  }
  if (!ok) {
    unreadable += 1;
    continue;
  }
  read += 1;
  for (const { key, attribution } of staged) {
    const report = reports.get(key) ?? new SpendReport();
    reports.set(key, report);
    report.add(attribution);
  }
}

const pct = (n: number) => `${(n * 100).toFixed(1).padStart(5)}%`;
console.log(
  `transcripts read: ${read}${unreadable ? `, ${unreadable} skipped (checksum mismatch)` : ''}`
);
if (rows.length === limit) {
  console.log(`note: stopped at --limit ${limit}; older transcripts in range were not read.`);
}
for (const [key, report] of reports) {
  console.log(
    `\n${key}  model calls=${report.calls}  unmeasurable=${report.skipped}` +
      `  input tokens=${Math.round(report.inputTokens)}  ${rateNotes.get(key) ?? ''}`
  );
  console.log('segment'.padEnd(34), 'tokens'.padStart(7), ' cost');
  for (const r of report.rows().slice(0, 15)) {
    console.log(r.key.padEnd(34), pct(r.tokenShare).padStart(7), pct(r.priceShare));
  }
}
await prisma.$disconnect();
