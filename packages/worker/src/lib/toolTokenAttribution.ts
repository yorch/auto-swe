import type { NormalizedCall } from '@auto-swe/shared/lib/transcripts/normalize';

/**
 * Where a model call's input tokens went, measured from the recorded request.
 *
 * A transcript holds each model call's full request and the provider's reported
 * usage, so nothing here estimates tokens or guesses how often a tool result is
 * re-sent: every request that carried a result is itself a record, and is
 * counted. The only approximation is the split of a call's real input total
 * across its segments, which is proportional to characters.
 */

/** Cache prices as multiples of the plain input price. */
export interface CacheRates {
  read: number;
  /** Applies to every cache write; the 1-hour tier is not priced separately. */
  write: number;
}

export interface SegmentSpend {
  tokens: number;
  /** Input tokens at plain-input-price equivalence: cached parts weighted by their rate. */
  priceEquivalent: number;
}

export interface CallAttribution {
  inputTokens: number;
  priceEquivalent: number;
  segments: Map<string, SegmentSpend>;
}

/**
 * The call's total input tokens, cached input included. Anthropic reports
 * `input_tokens` WITHOUT its cache parts; OpenAI and Google report a total that
 * includes them.
 */
export function totalInputTokens(call: NormalizedCall): number | undefined {
  const usage = call.response.usage;
  if (usage?.inputTokens === undefined || !Number.isFinite(usage.inputTokens)) {
    return undefined;
  }
  if (call.provider === 'anthropic') {
    return usage.inputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  }
  return usage.inputTokens;
}

/**
 * What an image weighs in the request, in characters at the ~3 chars/token the repo already
 * assumes (`pi/compaction.ts`): about 1,500 tokens, a typical screenshot. A recorded image is a
 * base64 blob or a bare reference, and its length says nothing about its tokens, so it is
 * given this fixed weight instead.
 */
const IMAGE_CHARS = 4_500;

/** A string that is one unbroken base64 run is a blob, not prose or code. */
const BASE64_BLOB = /^[A-Za-z0-9+/=]{4096,}$/;

/** A value's size as the provider renders it: a string as itself, anything else as JSON. */
function charCount(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * A tool result's size. Providers carry it as a string or as content blocks: a text block counts
 * as its text, not its JSON envelope, so a provider that wraps results does not look heavier
 * than one that does not. A base64 blob anywhere inside counts as {@link IMAGE_CHARS}.
 */
function resultChars(value: unknown): number {
  if (typeof value === 'string') {
    return BASE64_BLOB.test(value) ? IMAGE_CHARS : value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((n, block) => {
      if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
        return n + block.text.length;
      }
      return n + resultChars(block);
    }, 0);
  }
  return (
    JSON.stringify(value, (_key, v) =>
      typeof v === 'string' && BASE64_BLOB.test(v) ? 'x'.repeat(IMAGE_CHARS) : v
    )?.length ?? 0
  );
}

/** The request in the order a provider's prompt cache sees it, each piece sized in characters. */
function orderedSegments(call: NormalizedCall): { key: string; chars: number }[] {
  const names = new Map<string, string>();
  for (const message of call.messages) {
    for (const part of message.content) {
      if (part.type === 'tool_call') {
        names.set(part.id, part.name);
      }
    }
  }
  // Google keys a result by the function's name, so a call that has its own id is not found by it.
  const toolName = (id: string): string =>
    names.get(id) ?? ([...names.values()].includes(id) ? id : '?');
  const out: { key: string; chars: number }[] = [];
  if (call.tools?.length) {
    out.push({ chars: charCount(call.tools), key: 'tool_schemas' });
  }
  if (call.system) {
    out.push({ chars: call.system.length, key: 'system' });
  }
  for (const message of call.messages) {
    // OpenAI-style requests list the system prompt in `messages` as well as in `system`.
    if (message.role === 'system' && call.system) {
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          out.push({
            chars: part.text.length,
            key: message.role === 'assistant' ? 'assistant' : message.role,
          });
          break;
        case 'tool_call':
          out.push({
            chars: part.name.length + charCount(part.input),
            key: `tool_call:${part.name}`,
          });
          break;
        case 'tool_result':
          out.push({
            chars: resultChars(part.output),
            key: `tool_result:${toolName(part.id)}`,
          });
          break;
        default:
          out.push({ chars: IMAGE_CHARS, key: part.type });
      }
    }
  }
  return out.filter((s) => s.chars > 0);
}

/**
 * Split one call's real input across the pieces of its request. Cached tokens
 * are a prefix of the prompt (reads first, then writes), so the earliest pieces
 * are the cheap ones and a tool result late in the conversation is billed fresh.
 * Null when the call cannot be attributed: no usage, no content, or a request that is not a
 * real API exchange. A harness session file is one flattened copy of the conversation beside
 * usage summed over every API call of the turn, with no system prompt or tool schemas, so
 * spreading that usage over it would mis-weight everything.
 */
export function attributeCallContext(
  call: NormalizedCall,
  rates: CacheRates
): CallAttribution | null {
  if (call.source !== undefined && call.source !== 'http_call') {
    return null;
  }
  const total = totalInputTokens(call);
  if (total === undefined || total <= 0) {
    return null;
  }
  const pieces = orderedSegments(call);
  const chars = pieces.reduce((n, p) => n + p.chars, 0);
  if (chars === 0) {
    return null;
  }
  const read = Math.min(call.response.usage?.cacheRead ?? 0, total);
  const write = Math.min(call.response.usage?.cacheWrite ?? 0, total - read);

  const segments = new Map<string, SegmentSpend>();
  let priceEquivalent = 0;
  let start = 0;
  for (const piece of pieces) {
    const tokens = (total * piece.chars) / chars;
    const end = start + tokens;
    const readPart = Math.max(0, Math.min(end, read) - start);
    const writePart = Math.max(0, Math.min(end, read + write) - Math.max(start, read));
    const priced =
      readPart * rates.read + writePart * rates.write + (tokens - readPart - writePart);
    start = end;
    priceEquivalent += priced;
    const seen = segments.get(piece.key) ?? { priceEquivalent: 0, tokens: 0 };
    seen.tokens += tokens;
    seen.priceEquivalent += priced;
    segments.set(piece.key, seen);
  }
  return { inputTokens: total, priceEquivalent, segments };
}

export interface SpendRow extends SegmentSpend {
  key: string;
  tokenShare: number;
  priceShare: number;
}

/**
 * Sums call attributions. `priceEquivalent` is in units of the call's own model's input price,
 * so a report must cover ONE model (and one runtime): summing it across models adds unlike units.
 */
export class SpendReport {
  calls = 0;
  skipped = 0;
  inputTokens = 0;
  priceEquivalent = 0;
  private readonly bySegment = new Map<string, SegmentSpend>();

  add(attribution: CallAttribution | null): void {
    if (!attribution) {
      this.skipped += 1;
      return;
    }
    this.calls += 1;
    this.inputTokens += attribution.inputTokens;
    this.priceEquivalent += attribution.priceEquivalent;
    for (const [key, spend] of attribution.segments) {
      const seen = this.bySegment.get(key) ?? { priceEquivalent: 0, tokens: 0 };
      seen.tokens += spend.tokens;
      seen.priceEquivalent += spend.priceEquivalent;
      this.bySegment.set(key, seen);
    }
  }

  /** Largest price-equivalent spend first. */
  rows(): SpendRow[] {
    return [...this.bySegment]
      .map(([key, spend]) => ({
        ...spend,
        key,
        priceShare: this.priceEquivalent ? spend.priceEquivalent / this.priceEquivalent : 0,
        tokenShare: this.inputTokens ? spend.tokens / this.inputTokens : 0,
      }))
      .sort((a, b) => b.priceEquivalent - a.priceEquivalent);
  }
}
