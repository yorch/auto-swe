import { describe, expect, it } from 'vitest';
import {
  evaluatePushPolicy,
  formatViolations,
  type PolicyInputs,
  parseRawDiffZ,
  type RawChange,
} from './agentRunPolicy.js';

const sha = (n: number) => n.toString(16).padStart(40, '0');

function change(over: Partial<RawChange> & { path: string }): RawChange {
  return {
    newMode: '100644',
    newSha: sha(1),
    oldMode: '000000',
    status: 'A',
    ...over,
  };
}

async function run(changes: RawChange[], over: Partial<PolicyInputs> = {}) {
  return evaluatePushPolicy({
    allowWorkflowChanges: false,
    binaryBlobs: new Set(),
    blobSizes: new Map(changes.map((c) => [c.newSha, 10])),
    changes,
    checkSensitivePath: async () => null,
    ...over,
  });
}

describe('parseRawDiffZ', () => {
  it('parses entries separated by NUL', () => {
    const out =
      `:000000 100644 ${sha(0)} ${sha(1)} A\0src/a.ts\0` +
      `:100644 000000 ${sha(2)} ${sha(0)} D\0old name.txt\0`;
    expect(parseRawDiffZ(out)).toEqual([
      { newMode: '100644', newSha: sha(1), oldMode: '000000', path: 'src/a.ts', status: 'A' },
      { newMode: '000000', newSha: sha(0), oldMode: '100644', path: 'old name.txt', status: 'D' },
    ]);
  });

  it('parses an empty diff', () => {
    expect(parseRawDiffZ('')).toEqual([]);
  });

  it('throws (so the caller blocks) on anything it cannot parse', () => {
    expect(() => parseRawDiffZ('garbage\0path\0')).toThrow();
    expect(() => parseRawDiffZ(`:000000 100644 ${sha(0)} ${sha(1)} A\0`)).toThrow();
  });
});

describe('evaluatePushPolicy', () => {
  it('passes an ordinary text change', async () => {
    expect(await run([change({ path: 'src/a.ts' })])).toEqual([]);
  });

  it('blocks any path the sensitive-file scanner blocks, including deletions', async () => {
    const checkSensitivePath = async (p: string) => (p.endsWith('.env') ? 'sensitive' : null);
    const v = await run(
      [change({ path: 'a/.env' }), change({ newMode: '000000', path: '.env', status: 'D' })],
      { checkSensitivePath }
    );
    expect(v.map((x) => [x.rule, x.path])).toEqual([
      ['sensitive_file', 'a/.env'],
      ['sensitive_file', '.env'],
    ]);
  });

  it('fails closed when the sensitive-file check itself throws', async () => {
    const v = await run([change({ path: 'a.txt' })], {
      checkSensitivePath: async () => {
        throw new Error('boom');
      },
    });
    expect(v.map((x) => x.rule)).toEqual(['sensitive_file']);
  });

  it('blocks symlinks and gitlinks, whether added, changed or removed', async () => {
    const v = await run([
      change({ newMode: '120000', path: 'link' }),
      change({ newMode: '160000', path: 'vendor/sub' }),
      change({ newMode: '000000', oldMode: '120000', path: 'gone-link', status: 'D' }),
      change({ newMode: '100644', oldMode: '120000', path: 'was-link', status: 'T' }),
    ]);
    expect(v.map((x) => x.rule)).toEqual(['symlink', 'gitlink', 'symlink', 'symlink']);
  });

  it('blocks binaries by content', async () => {
    const bin = sha(7);
    const v = await run([change({ newSha: bin, path: 'logo.png' })], {
      binaryBlobs: new Set([bin]),
    });
    expect(v.map((x) => x.rule)).toEqual(['binary']);
  });

  it('blocks a file over the size limit and one whose size is unknown', async () => {
    const big = sha(8);
    const unknown = sha(9);
    const v = await run(
      [change({ newSha: big, path: 'big.txt' }), change({ newSha: unknown, path: 'mystery.txt' })],
      { blobSizes: new Map([[big, 5_000_000]]) }
    );
    expect(v.map((x) => x.rule)).toEqual(['file_too_large', 'unclassifiable_path']);
  });

  it('blocks workflow and action files unless the setting allows them', async () => {
    const changes = [
      change({ path: '.github/workflows/ci.yml' }),
      change({ path: '.github/actions/setup/action.yml' }),
      change({ path: 'docs/.github/workflows/not-root.yml' }),
    ];
    const blocked = await run(changes);
    expect(blocked.map((x) => [x.rule, x.path])).toEqual([
      ['workflow_file', '.github/workflows/ci.yml'],
      ['workflow_file', '.github/actions/setup/action.yml'],
    ]);
    expect(await run(changes, { allowWorkflowChanges: true })).toEqual([]);
  });

  it('still blocks a sensitive workflow file when workflow changes are allowed', async () => {
    const v = await run([change({ path: '.github/workflows/secrets.env' })], {
      allowWorkflowChanges: true,
      checkSensitivePath: async () => 'sensitive',
    });
    expect(v.map((x) => x.rule)).toEqual(['sensitive_file']);
  });

  it('rejects paths it cannot safely classify', async () => {
    const v = await run([
      change({ path: 'a\nb' }),
      change({ path: '../escape' }),
      change({ path: '/abs' }),
    ]);
    expect(v.map((x) => x.rule)).toEqual([
      'unclassifiable_path',
      'unclassifiable_path',
      'unclassifiable_path',
    ]);
  });

  it('rejects a path that was not valid UTF-8 (decoded to U+FFFD)', async () => {
    const v = await run([change({ path: 'src/caf\uFFFD.ts' })]);
    expect(v.map((x) => x.rule)).toEqual(['unclassifiable_path']);
  });

  it('rejects an unknown diff status', async () => {
    const v = await run([change({ path: 'a', status: 'U' })]);
    expect(v.map((x) => x.rule)).toEqual(['unexpected_status']);
  });

  it('refuses a change touching too many files without classifying them', async () => {
    const many = Array.from({ length: 501 }, (_, i) => change({ path: `f${i}.txt` }));
    const v = await run(many);
    expect(v.map((x) => x.rule)).toEqual(['too_many_files']);
  });

  it('formats one line per violation', async () => {
    const v = await run([change({ newMode: '120000', path: 'l' })]);
    expect(formatViolations(v)).toContain('[symlink] l:');
  });
});
