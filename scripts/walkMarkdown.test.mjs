import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitIgnoredPaths, walkMarkdown } from './walkMarkdown.mjs';

const roots = [];
const tree = (files) => {
  const root = mkdtempSync(join(tmpdir(), 'walk-md-'));
  roots.push(root);
  for (const f of files) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), '# x\n');
  }
  return root;
};

afterEach(() => {
  for (const r of roots.splice(0)) {
    rmSync(r, { force: true, recursive: true });
  }
});

const none = { ignored: new Set(), warn: () => {} };

describe('walkMarkdown', () => {
  it('collects .md files and skips vendor, build and worktree directories', () => {
    const root = tree([
      'README.md',
      'docs/a.md',
      'docs/note.txt',
      'node_modules/p/README.md',
      'data/postgres/x.md',
      'docs/data/x.md',
      '.next/x.md',
      '.claude/worktrees/w/README.md',
      '.claude/skills/s/SKILL.md',
    ]);
    // Only the root `data/` is skipped: a `docs/data/` is real documentation.
    expect(walkMarkdown(root, '.', none).sort()).toEqual([
      '.claude/skills/s/SKILL.md',
      'README.md',
      'docs/a.md',
      'docs/data/x.md',
    ]);
  });

  it('skips directories the ignore set names', () => {
    const root = tree(['docs/a.md', 'scratch/b.md']);
    expect(walkMarkdown(root, '.', { ...none, ignored: new Set(['scratch']) }).sort()).toEqual([
      'docs/a.md',
    ]);
  });

  it('skips gitignored files, not only directories', () => {
    const root = tree(['docs/a.md', 'site/src/content/docs/generated.md']);
    expect(
      walkMarkdown(root, '.', { ...none, ignored: new Set(['site/src/content/docs/generated.md']) })
    ).toEqual(['docs/a.md']);
  });

  it('reads the ignored files and directories from git, and falls back to none without it', () => {
    const root = tree(['keep.md', 'gen.md', 'out-dir/x.md', '.gitignore']);
    writeFileSync(join(root, '.gitignore'), 'gen.md\nout-dir/\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    expect(gitIgnoredPaths(root)).toEqual(new Set(['gen.md', 'out-dir']));
    expect(walkMarkdown(root, '.', { warn: () => {} })).toEqual(['keep.md']);
    // Not a repository: no ignore information, so only the name lists apply.
    const bare = tree(['a.md']);
    expect(gitIgnoredPaths(bare)).toEqual(new Set());
  });

  it.skipIf(process.getuid?.() === 0)(
    'warns and keeps going when a directory is unreadable',
    () => {
      const root = tree(['docs/a.md', 'secret/b.md']);
      chmodSync(join(root, 'secret'), 0o000);
      const warnings = [];
      try {
        expect(
          walkMarkdown(root, '.', { ignored: new Set(), warn: (m) => warnings.push(m) })
        ).toEqual(['docs/a.md']);
      } finally {
        chmodSync(join(root, 'secret'), 0o755);
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/secret/);
    }
  );
});
