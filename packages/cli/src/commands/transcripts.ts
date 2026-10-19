import { createWriteStream } from 'node:fs';
import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { parseFlags } from '../lib/flags.js';

/**
 * `auto-swe transcripts` — inspect and export agent transcripts.
 */

const SUB_HELP = `auto-swe transcripts — inspect agent transcripts

  transcripts list <runId>                            List a run's transcripts
  transcripts get <transcriptId> [--format=raw|normalized] [--scrub-pii] [-o file]
                                                      Transcript metadata + NDJSON content
  transcripts export --from=ISO --to=ISO [--agent=KEY] [--format=raw|normalized] [--scrub-pii] [-o file]
                                                      Admin export across transcripts
`;

interface TranscriptMeta {
  activityOutcome: string | null;
  activityType: string;
  agentKeys: string[];
  attempt: number;
  createdAt: string;
  id: string;
  legalHold: boolean;
  modelCallCount: number;
  runtime: string;
  sizeBytes: number;
  status: string;
}

async function streamToFile(path: string, out: string | undefined, env: CliEnv): Promise<number> {
  const res = await fetch(`${env.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${env.token}` },
  });
  if (!res.ok || !res.body) {
    process.stderr.write(`request failed: HTTP ${res.status}\n`);
    return 2;
  }
  // The stream must end with the eof sentinel; a missing one means the gateway
  // tore the connection mid-transcript and the output is incomplete.
  let tail = '';
  if (out) {
    const ws = createWriteStream(out);
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      ws.write(chunk);
      tail = (tail + Buffer.from(chunk).toString('utf8')).slice(-256);
    }
    await new Promise((r) => ws.end(r));
  } else {
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      const text = Buffer.from(chunk).toString('utf8');
      process.stdout.write(text);
      tail = (tail + text).slice(-256);
    }
  }
  const lastLine = tail.trim().split('\n').at(-1) ?? '';
  let eof = false;
  try {
    const parsed = JSON.parse(lastLine) as { complete?: boolean; kind?: string };
    eof = parsed.kind === 'eof' && parsed.complete === true;
  } catch {
    eof = false;
  }
  if (!eof) {
    process.stderr.write('incomplete transcript stream: no eof sentinel\n');
    return 2;
  }
  if (out) {
    process.stderr.write(`wrote ${out}\n`);
  }
  return 0;
}

export async function runTranscriptsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'list') {
      const runId = rest[0];
      if (!runId) {
        process.stderr.write('transcripts list requires a run id\n');
        return 1;
      }
      const transcripts = await apiRequest<TranscriptMeta[]>(
        env,
        'GET',
        `/api/v1/workflow-runs/${runId}/transcripts`
      );
      for (const t of transcripts) {
        process.stdout.write(
          `${t.id}  ${t.status.padEnd(10)} ${t.runtime.padEnd(12)} ${t.activityType} attempt=${t.attempt} calls=${t.modelCallCount} ${t.sizeBytes}B ${t.createdAt}${t.legalHold ? ' [legal-hold]' : ''}\n`
        );
      }
      return 0;
    }
    if (sub === 'get') {
      const { flags, positional } = parseFlags(rest);
      const id = positional[0];
      if (!id) {
        process.stderr.write('transcripts get requires a transcript id\n');
        return 1;
      }
      const meta = await apiRequest<{
        parts: { recordCount: number; seq: number; sha256: string; sizeBytes: number }[];
        transcript: TranscriptMeta;
      }>(env, 'GET', `/api/v1/transcripts/${id}`);
      process.stdout.write(`${JSON.stringify(meta, null, 2)}\n`);
      const format = flags.format === 'normalized' ? 'normalized' : 'raw';
      const scrub = flags['scrub-pii'] !== undefined && String(flags['scrub-pii']) !== 'false';
      return await streamToFile(
        `/api/v1/transcripts/${id}/content?format=${format}&scrubPii=${scrub}`,
        typeof flags.o === 'string' ? flags.o : undefined,
        env
      );
    }
    if (sub === 'export') {
      const { flags } = parseFlags(rest);
      if (typeof flags.from !== 'string' || typeof flags.to !== 'string') {
        process.stderr.write('transcripts export requires --from and --to ISO dates\n');
        return 1;
      }
      const format = flags.format === 'normalized' ? 'normalized' : 'raw';
      const scrub = flags['scrub-pii'] !== undefined && String(flags['scrub-pii']) !== 'false';
      const params = new URLSearchParams({
        format,
        from: flags.from,
        scrubPii: String(scrub),
        to: flags.to,
      });
      if (typeof flags.agent === 'string') {
        params.set('agentKey', flags.agent);
      }
      if (typeof flags['activity-type'] === 'string') {
        params.set('activityType', flags['activity-type']);
      }
      return await streamToFile(
        `/api/v1/platform/transcripts/export?${params}`,
        typeof flags.o === 'string' ? flags.o : undefined,
        env
      );
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: transcripts ${sub}\n${SUB_HELP}`);
  return 1;
}
