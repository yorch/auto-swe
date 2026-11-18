import { describe, expect, it } from 'vitest';
import { validateSpec } from '../validateSpec.js';
import { buildValidatePhase, canonicalCoreIds } from './canonicalCore.js';
import { cleanPlanSpecText } from './cleanSpecText.js';
import {
  canonicalDeliveringRaw,
  clone,
  deliveringRaw,
  deliveringWithGatesRaw,
  outputOnlyRaw,
  parse,
  type RawSpec,
} from './skeletonFixtures.js';
import { checkSkeletonPolicy, type SkeletonMode } from './skeletonPolicy.js';
import { hashRunPlanSpec } from './specHash.js';

const HOSTILE = 'Ship‮ it​ [click](https://evil.example/x) <b>now</b> https://evil.example/p';

/** Every free node gets a hostile title and group. */
function taint(raw: RawSpec): RawSpec {
  const reserved = new Set([...canonicalCoreIds(), ...Object.keys(buildValidatePhase())]);
  const out = clone(raw);
  for (const [id, node] of Object.entries(out.nodes)) {
    if (!reserved.has(id)) {
      node.title = HOSTILE;
      node.group = 'grp​ <i>x</i>';
    }
  }
  return out;
}

const verdict = (raw: RawSpec, mode: SkeletonMode) => {
  const spec = parse(raw);
  return {
    policy: checkSkeletonPolicy(spec, mode).errors.map((e) => e.code),
    validation: validateSpec(spec, { rejectNonLaunchableAgents: true }).errors.map((e) => e.code),
  };
};

describe('cleanPlanSpecText', () => {
  it('cleans titles and groups of free nodes only', () => {
    const raw = taint(canonicalDeliveringRaw());
    const cleaned = cleanPlanSpecText(raw);
    expect(cleaned.nodes.research.title).toBe('Ship it click now');
    expect(cleaned.nodes.research.group).toBe('grp x');
    // Input is not mutated.
    expect(raw.nodes.research.title).toBe(HOSTILE);
  });

  it('leaves canonical core and validate-phase nodes byte-identical', () => {
    const raw = canonicalDeliveringRaw();
    for (const id of [...canonicalCoreIds(), ...Object.keys(buildValidatePhase())]) {
      raw.nodes[id].title = HOSTILE; // would be cleaned on a free node
    }
    const cleaned = cleanPlanSpecText(raw);
    for (const id of [...canonicalCoreIds(), ...Object.keys(buildValidatePhase())]) {
      expect(JSON.stringify(cleaned.nodes[id])).toBe(JSON.stringify(raw.nodes[id]));
    }
  });

  it('reserves no ids in an output-only plan, where `review` and `done` are ordinary nodes', () => {
    const raw = clone(outputOnlyRaw());
    raw.nodes.reviewDraft.title = HOSTILE;
    raw.nodes.done.title = HOSTILE;
    const cleaned = cleanPlanSpecText(raw, 'output-only');
    expect(cleaned.nodes.done.title).toBe('Ship it click now');
    expect(cleaned.nodes.reviewDraft.title).toBe('Ship it click now');
    // Without a mode the core ids stay reserved.
    expect(cleanPlanSpecText(raw).nodes.done.title).toBe(HOSTILE);
  });

  it('is idempotent', () => {
    const once = cleanPlanSpecText(taint(canonicalDeliveringRaw()));
    expect(cleanPlanSpecText(once)).toEqual(once);
  });

  it('bounds over-long text by the field and drops an optional field it empties', () => {
    const raw = clone(outputOnlyRaw());
    const first = 'draft';
    raw.nodes[first].title = 'a'.repeat(500);
    raw.nodes[first].group = '​​';
    const cleaned = cleanPlanSpecText(raw).nodes[first];
    expect((cleaned.title as string).length).toBeLessThanOrEqual(80);
    expect('group' in cleaned).toBe(false);
  });

  it('keeps a human title non-empty and cleans its description and option labels', () => {
    const raw = clone(outputOnlyRaw());
    raw.nodes.ask = {
      description: 'See <script>x</script> https://evil.example',
      onTimeout: Object.keys(raw.nodes)[0],
      options: [
        { label: '​', next: Object.keys(raw.nodes)[0], value: 'a' },
        { label: '[go](https://evil.example)', next: Object.keys(raw.nodes)[0], value: 'b' },
      ],
      timeout: '1h',
      title: '​<b></b>',
      type: 'humanDecision',
    };
    const node = cleanPlanSpecText(raw).nodes.ask as Record<string, unknown>;
    expect(node.title).toBe('ask');
    expect(String(node.description)).not.toMatch(/https|script/);
    const options = node.options as Array<{ label: string; value: string }>;
    expect(options.map((o) => o.label)).toEqual(['Option 1', 'go']);
    expect(options.map((o) => o.value)).toEqual(['a', 'b']);
  });

  it('keeps option labels unique after cleaning, deterministically and idempotently', () => {
    const raw = clone(outputOnlyRaw());
    const target = Object.keys(raw.nodes)[0] as string;
    raw.nodes.ask = {
      onTimeout: target,
      options: [
        { label: '**Yes**', next: target, value: 'a' },
        { label: 'Yes', next: target, value: 'b' },
        { label: ' yes ', next: target, value: 'c' },
        { label: '\u200b', next: target, value: 'd' },
        { label: 'Option 4', next: target, value: 'e' },
        { label: 'x'.repeat(150), next: target, value: 'f' },
        { label: 'x'.repeat(150), next: target, value: 'g' },
      ],
      timeout: '1h',
      title: 'ask',
      type: 'humanDecision',
    };
    const once = cleanPlanSpecText(raw);
    const options = (once.nodes.ask as { options: Array<{ label: string; value: string }> })
      .options;
    const labels = options.map((o) => o.label);
    expect(labels.slice(0, 3)).toEqual(['Yes', 'Yes (2)', 'yes (3)']);
    // The empty label falls back to `Option 4`; the earlier of two equal labels keeps its text.
    expect(labels[3]).toBe('Option 4');
    expect(labels[4]).toBe('Option 4 (2)');
    // Both long labels cut to 99 characters and an ellipsis; the base is shortened to fit the suffix.
    expect(labels[6]).toBe(`${'x'.repeat(96)} (2)`);
    expect(labels.every((l) => l.length <= 100)).toBe(true);
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(labels.length);
    expect(options.map((o) => o.value)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(cleanPlanSpecText(once)).toEqual(once);
  });

  it('keeps input field labels unique after cleaning', () => {
    const raw = clone(outputOnlyRaw());
    const target = Object.keys(raw.nodes)[0] as string;
    raw.nodes.form = {
      fields: [
        { key: 'a', label: '[Name](https://evil.example)', type: 'text' },
        { key: 'b', label: 'Name', type: 'text' },
        { key: 'c', label: '\u200b', type: 'text' },
        { key: 'c', label: '`c`', type: 'text' },
      ],
      next: target,
      title: 'form',
      type: 'humanInput',
    };
    const once = cleanPlanSpecText(raw);
    const labels = (once.nodes.form as { fields: Array<{ label: string }> }).fields.map(
      (f) => f.label
    );
    expect(labels).toEqual(['Name', 'Name (2)', 'c', 'c (2)']);
    expect(cleanPlanSpecText(once)).toEqual(once);
  });

  it('cleans a terminal shorthand message but not its status', () => {
    const raw = clone(outputOnlyRaw());
    const first = 'draft';
    raw.nodes[first].onFailure = { message: 'bad‮ https://evil.example', status: 'FAILED' };
    const target = cleanPlanSpecText(raw).nodes[first].onFailure as Record<string, unknown>;
    expect(target).toEqual({ message: 'bad', status: 'FAILED' });
  });

  it('returns a non-spec as it is', () => {
    expect(cleanPlanSpecText(null)).toBeNull();
    expect(cleanPlanSpecText('x')).toBe('x');
    const odd = { nodes: [] };
    expect(cleanPlanSpecText(odd)).toBe(odd);
  });

  it('changes the hash only through the cleaned text', () => {
    const raw = taint(canonicalDeliveringRaw());
    expect(hashRunPlanSpec(cleanPlanSpecText(raw))).not.toBe(hashRunPlanSpec(raw));
    const clean = cleanPlanSpecText(raw);
    expect(hashRunPlanSpec(cleanPlanSpecText(clean))).toBe(hashRunPlanSpec(clean));
  });

  describe('never turns an accepted plan into a refused one', () => {
    const cases: Array<[string, () => RawSpec, SkeletonMode]> = [
      ['delivering', deliveringRaw, 'delivering'],
      ['delivering with gates', deliveringWithGatesRaw, 'delivering'],
      ['canonical delivering', canonicalDeliveringRaw, 'delivering'],
      ['output only', outputOnlyRaw, 'output-only'],
    ];
    for (const [name, build, mode] of cases) {
      it(name, () => {
        const before = verdict(build(), mode);
        const tainted = taint(build());
        const cleaned = cleanPlanSpecText(tainted);
        expect(verdict(cleanPlanSpecText(tainted, mode), mode)).toEqual(before);
        expect(verdict(cleaned, mode)).toEqual(before);
        expect(verdict(tainted, mode)).toEqual(before);
      });
    }
  });
});
