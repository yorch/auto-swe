import { createHash } from 'node:crypto';
import { vi } from 'vitest';

/**
 * A fake GitHub that serves real, nested git trees (`/git/trees/<sha>` with and without
 * `?recursive=1`), so the truncated-listing fallback can be walked. Tests only.
 *
 * `truncated(path, recursive)` says whether the listing of directory `path` ('' is the root) comes
 * back with `truncated: true`; the default is that none does.
 */
export const blobId = (b: Buffer) =>
  createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

export interface TreeHubFile {
  path: string;
  content: string;
  mode?: string;
}

export function treeHub(
  files: TreeHubFile[],
  opts: {
    commit: string;
    truncated?: (dir: string, recursive: boolean) => boolean;
  }
) {
  const blobs = new Map<string, Buffer>();
  const dirs = new Set<string>(['']);
  for (const f of files) {
    const parts = f.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
    const b = Buffer.from(f.content);
    blobs.set(blobId(b), b);
  }
  const dirSha = (dir: string) => createHash('sha1').update(`dir:${dir}`).digest('hex');
  const byTreeSha = new Map([...dirs].map((d) => [dirSha(d), d]));
  const entryOf = (path: string, rel: string) => {
    const f = files.find((x) => x.path === path);
    if (f) {
      const b = Buffer.from(f.content);
      return { mode: f.mode ?? '100644', path: rel, sha: blobId(b), size: b.length, type: 'blob' };
    }
    return { mode: '040000', path: rel, sha: dirSha(path), type: 'tree' };
  };
  const children = (dir: string) => {
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const p of [...files.map((f) => f.path), ...dirs]) {
      if (p !== '' && p.startsWith(prefix) && p !== dir) {
        names.add(p.slice(prefix.length).split('/')[0] as string);
      }
    }
    return [...names].sort().map((n) => `${prefix}${n}`);
  };
  const descendants = (dir: string): string[] => {
    const prefix = dir === '' ? '' : `${dir}/`;
    return [...files.map((f) => f.path), ...[...dirs].filter((d) => d !== '')]
      .filter((p) => p.startsWith(prefix) && p !== dir)
      .sort();
  };
  const urls: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.includes('/commits/')) {
      return ok({ sha: opts.commit });
    }
    const t = /\/git\/trees\/([0-9a-f]+)(\?recursive=1)?$/.exec(u);
    if (t) {
      const dir = t[1] === opts.commit ? '' : byTreeSha.get(t[1] as string);
      if (dir === undefined) {
        return new Response('{}', { status: 404 });
      }
      const recursive = t[2] !== undefined;
      const prefix = dir === '' ? '' : `${dir}/`;
      const paths = recursive ? descendants(dir) : children(dir);
      const truncated = opts.truncated?.(dir, recursive) ?? false;
      return ok({
        // A truncated answer is partial: it leaves entries out.
        tree: (truncated ? paths.slice(0, 1) : paths).map((p) =>
          entryOf(p, p.slice(prefix.length))
        ),
        truncated,
      });
    }
    const m = /\/git\/blobs\/([0-9a-f]+)/.exec(u);
    const b = m ? blobs.get(m[1] as string) : undefined;
    return b
      ? ok({ content: b.toString('base64'), encoding: 'base64' })
      : new Response('{}', { status: 404 });
  });
  return { fetchFn: fn as unknown as typeof fetch, mock: fn, urls };
}
