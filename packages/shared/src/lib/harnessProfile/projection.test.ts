import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveSetting, scanSkillContent } = vi.hoisted(() => ({
  resolveSetting: vi.fn(),
  scanSkillContent: vi.fn(),
}));
vi.mock('../../config/index.js', () => ({ resolveSetting }));
vi.mock('../skillScanner.js', () => ({ scanSkillContent }));

import { skillContentHash } from '../skillRevision.js';
import {
  OLDER_VERSION_REASON,
  PROJECTION_SOURCE_PREFIX,
  type ProjectionFile,
  projectPluginSkills,
} from './projection.js';

const file = (path: string, text: string): ProjectionFile => ({
  bytes: Buffer.from(text),
  mode: '100644',
  path,
});

const skillMd = (name: string | null, description: string | null, body = 'Do the thing.') =>
  [
    '---',
    ...(name === null ? [] : [`name: ${name}`]),
    ...(description === null ? [] : [`description: ${description}`]),
    '---',
    body,
  ].join('\n');

const PLUGIN_JSON = JSON.stringify({ name: 'acme' });

function files(extra: ProjectionFile[] = []): ProjectionFile[] {
  return [
    file('plugins/acme/.claude-plugin/plugin.json', PLUGIN_JSON),
    file('plugins/acme/skills/review/SKILL.md', skillMd('code-review', 'Reviews code')),
    file('plugins/acme/skills/review/checklist.md', '- one'),
    file('plugins/acme/skills/review/run.sh', 'echo no'),
    file('plugins/acme/skills/plain/SKILL.md', skillMd(null, 'Plain skill', 'Plain body')),
    file('plugins/acme/commands/x.md', 'not a skill'),
    ...extra,
  ];
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  promptText: string;
  currentRevision: number;
  pluginProfileId: string | null;
  pluginVersion: number | null;
}

function fakeDb(rows: Row[] = [], projected: Record<string, { contentHash: string } | null> = {}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    skill: {
      create: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(
        async ({ where }: { where: { name: string } }) =>
          rows.find((r) => r.name === where.name) ?? null
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    skillRevision: {
      findFirst: vi.fn(
        async ({ where }: { where: { skillId: string } }) => projected[where.skillId] ?? null
      ),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { db: db as never, tx };
}

const INPUT = {
  commitSha: 'a'.repeat(40),
  createdById: 'u1',
  manifest: { plugins: ['plugins/acme'] },
  profileId: 'p1',
  profileName: 'acme-pack',
  version: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveSetting.mockResolvedValue(true);
  scanSkillContent.mockResolvedValue({ incomplete: false, safe: true, warnings: [] });
});

describe('projectPluginSkills', () => {
  it('creates namespaced, unverified rows with reference files and a revision', async () => {
    const { db, tx } = fakeDb();
    const res = await projectPluginSkills(db, { ...INPUT, files: files() });
    expect(res).toEqual({
      created: ['acme:plain', 'acme:code-review'],
      refused: [],
      updated: [],
    });
    const creates = tx.skill.create.mock.calls.map((c) => c[0].data);
    const review = creates.find((d) => d.name === 'acme:code-review');
    expect(review).toMatchObject({
      description: 'Reviews code',
      isBuiltIn: false,
      isVerified: false,
      pluginProfileId: 'p1',
      pluginVersion: 1,
      promptText: 'Do the thing.',
      scope: 'GLOBAL',
    });
    expect(review.revisions.create).toMatchObject({
      referenceFiles: [{ content: '- one', path: 'checklist.md' }],
      revision: 1,
      sourcePath: `${PROJECTION_SOURCE_PREFIX}acme-pack/plugins/acme/skills/review`,
      sourceSha: 'a'.repeat(40),
    });
    // The directory name stands in for a missing frontmatter name.
    expect(creates.some((d) => d.name === 'acme:plain')).toBe(true);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a skill with scan warnings while the setting blocks them, and writes nothing for it', async () => {
    scanSkillContent.mockResolvedValueOnce({
      incomplete: false,
      safe: false,
      warnings: ['injection:x'],
    });
    const { db, tx } = fakeDb();
    const res = await projectPluginSkills(db, { ...INPUT, files: files() });
    expect(res.refused).toHaveLength(1);
    expect(res.refused[0]?.reason).toContain('injection:x');
    expect(res.created).toHaveLength(1);
    expect(tx.skill.create).toHaveBeenCalledTimes(1);
  });

  it('installs a skill with warnings when the setting is off, recording them', async () => {
    resolveSetting.mockResolvedValue(false);
    scanSkillContent.mockResolvedValue({ incomplete: true, safe: true, warnings: ['w'] });
    const { db, tx } = fakeDb();
    const res = await projectPluginSkills(db, { ...INPUT, files: files() });
    expect(res.created).toHaveLength(2);
    expect(tx.skill.create.mock.calls[0]?.[0].data.revisions.create.scanWarnings).toEqual([
      'w',
      'scan-incomplete: some patterns could not be evaluated',
    ]);
  });

  it('reports a SKILL.md the parser refuses, without a write', async () => {
    const { db, tx } = fakeDb();
    const res = await projectPluginSkills(db, {
      ...INPUT,
      files: files([file('plugins/acme/skills/bad/SKILL.md', skillMd('bad', null))]),
    });
    expect(res.refused).toEqual([
      { name: 'acme:bad', reason: 'frontmatter description is missing' },
    ]);
    expect(tx.skill.create).toHaveBeenCalledTimes(2);
  });

  it('updates an untouched row with a new revision and resets verification', async () => {
    const live = { description: 'Old', promptText: 'old body' };
    const row: Row = {
      currentRevision: 3,
      description: live.description,
      id: 's1',
      name: 'acme:code-review',
      pluginProfileId: 'p1',
      pluginVersion: 1,
      promptText: live.promptText,
    };
    const { db, tx } = fakeDb([row], { s1: { contentHash: skillContentHash(live) } });
    const res = await projectPluginSkills(db, { ...INPUT, files: files(), version: 2 });
    expect(res.updated).toEqual(['acme:code-review']);
    expect(res.created).toEqual(['acme:plain']);
    const call = tx.skill.update.mock.calls[0]?.[0];
    expect(call.where).toEqual({ currentRevision: 3, id: 's1' });
    expect(call.data).toMatchObject({
      currentRevision: 4,
      isVerified: false,
      pluginVersion: 2,
      promptText: 'Do the thing.',
    });
  });

  it('refuses to project a version older than the one a row came from', async () => {
    const live = { description: 'Old', promptText: 'old body' };
    const row: Row = {
      currentRevision: 3,
      description: live.description,
      id: 's1',
      name: 'acme:code-review',
      pluginProfileId: 'p1',
      pluginVersion: 3,
      promptText: live.promptText,
    };
    const { db, tx } = fakeDb([row], { s1: { contentHash: skillContentHash(live) } });
    const res = await projectPluginSkills(db, { ...INPUT, files: files(), version: 1 });
    expect(res.refused).toEqual([{ name: 'acme:code-review', reason: OLDER_VERSION_REASON }]);
    expect(res.updated).toEqual([]);
    expect(tx.skill.update).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a row whose live text differs from its last projection', async () => {
    const row: Row = {
      currentRevision: 4,
      description: 'Reviews code',
      id: 's1',
      name: 'acme:code-review',
      pluginProfileId: 'p1',
      pluginVersion: 1,
      promptText: 'edited by an admin',
    };
    const { db, tx } = fakeDb([row], {
      s1: {
        contentHash: skillContentHash({ description: 'Reviews code', promptText: 'Do the thing.' }),
      },
    });
    const res = await projectPluginSkills(db, { ...INPUT, files: files(), version: 2 });
    expect(res.refused).toEqual([
      { name: 'acme:code-review', reason: expect.stringContaining('edited by hand') },
    ]);
    expect(tx.skill.update).not.toHaveBeenCalled();
  });

  it('refuses a row with no projection revision at all', async () => {
    const row: Row = {
      currentRevision: 1,
      description: 'Reviews code',
      id: 's1',
      name: 'acme:code-review',
      pluginProfileId: 'p1',
      pluginVersion: 1,
      promptText: 'Do the thing.',
    };
    const { db, tx } = fakeDb([row], { s1: null });
    const res = await projectPluginSkills(db, { ...INPUT, files: files() });
    expect(res.refused.map((r) => r.name)).toEqual(['acme:code-review']);
    expect(tx.skill.update).not.toHaveBeenCalled();
  });

  it('leaves an unchanged row alone, bumping only the version it came from', async () => {
    const live = { description: 'Reviews code', promptText: 'Do the thing.' };
    const row: Row = {
      currentRevision: 1,
      ...live,
      id: 's1',
      name: 'acme:code-review',
      pluginProfileId: 'p1',
      pluginVersion: 1,
    };
    const { db, tx } = fakeDb([row], { s1: { contentHash: skillContentHash(live) } });
    const res = await projectPluginSkills(db, { ...INPUT, files: files(), version: 2 });
    expect(res.updated).toEqual([]);
    expect(tx.skill.update).toHaveBeenCalledWith({
      data: { pluginVersion: 2 },
      where: { id: 's1' },
    });
  });

  it('refuses a name held by an ordinary skill or another plugin', async () => {
    const base = {
      currentRevision: 1,
      description: 'x',
      id: 'x1',
      pluginVersion: null,
      promptText: 'x',
    };
    const { db } = fakeDb([
      { ...base, name: 'acme:code-review', pluginProfileId: null },
      { ...base, id: 'x2', name: 'acme:plain', pluginProfileId: 'other' },
    ]);
    const res = await projectPluginSkills(db, { ...INPUT, files: files() });
    expect(res.created).toEqual([]);
    expect(res.refused.map((r) => r.name).sort()).toEqual(['acme:code-review', 'acme:plain']);
  });

  it('keeps an installed skill that vanished upstream and reports nothing for it', async () => {
    const { db } = fakeDb();
    const res = await projectPluginSkills(db, {
      ...INPUT,
      files: [file('plugins/acme/.claude-plugin/plugin.json', PLUGIN_JSON)],
    });
    expect(res).toEqual({ created: [], refused: [], updated: [] });
  });

  it('names the plugin from its directory when plugin.json has no usable name', async () => {
    const { db, tx } = fakeDb();
    await projectPluginSkills(db, {
      ...INPUT,
      files: [
        file('plugins/acme/.claude-plugin/plugin.json', '{}'),
        file('plugins/acme/skills/a/SKILL.md', skillMd('one', 'd')),
      ],
    });
    expect(tx.skill.create.mock.calls[0]?.[0].data.name).toBe('acme:one');
  });

  it('works inside a caller transaction (no $transaction on the client)', async () => {
    const { tx } = fakeDb();
    const res = await projectPluginSkills(tx as never, { ...INPUT, files: files() });
    expect(res.created).toHaveLength(2);
  });
});
