/**
 * The registry proxy's tarball cache: a flat directory per registry keyed by
 * the sha256 of the upstream URL path. Tarballs are immutable, so a complete
 * entry is always safe to serve; a partial download never lands because a
 * write commits by rename only after the whole response streamed.
 *
 * Every operation is best-effort at the caller — methods throw and the proxy
 * falls through to the upstream on any error; nothing here must ever take a
 * workspace install down.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

export interface CacheWrite {
  write(chunk: Uint8Array): Promise<void>;
  /** Renames the temp file into place and runs eviction. */
  commit(): Promise<void>;
  /** Drops the temp file (incomplete or non-200 response). */
  abort(): Promise<void>;
}

export interface CacheHit {
  createStream(): ReadStream;
}

/**
 * After a write, files past `maxBytes` are evicted oldest-mtime-first until
 * the total is back under 90% of it.
 */
const EVICT_FRACTION = 0.9;

export class TarballCache {
  constructor(
    private readonly dir: string,
    private readonly maxBytes: number
  ) {}

  private key(registryId: string, upstreamPath: string): { dir: string; file: string } {
    const dir = join(this.dir, registryId);
    const file = join(dir, `${createHash('sha256').update(upstreamPath).digest('hex')}.tgz`);
    return { dir, file };
  }

  /** A readable hit, or `null` on a miss. Touches mtime so LRU eviction spares hot entries. */
  async get(registryId: string, upstreamPath: string): Promise<CacheHit | null> {
    const { file } = this.key(registryId, upstreamPath);
    try {
      await stat(file);
      await utimes(file, new Date(), new Date());
      return { createStream: () => createReadStream(file) };
    } catch {
      return null;
    }
  }

  /** Start a streaming write to a temp file; `commit` moves it into the cache. */
  async startWrite(registryId: string, upstreamPath: string): Promise<CacheWrite> {
    const { dir, file } = this.key(registryId, upstreamPath);
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const stream: WriteStream = createWriteStream(tmp);
    const done = () =>
      new Promise<void>((resolve, reject) => {
        stream.once('error', reject);
        stream.once('finish', resolve);
      });
    let failed = false;
    const self = this;
    return {
      async abort() {
        stream.destroy();
        await rm(tmp, { force: true });
      },
      async commit() {
        stream.end();
        await done();
        if (failed) {
          await rm(tmp, { force: true });
          return;
        }
        await rename(tmp, file);
        await self.evict().catch(() => {});
      },
      async write(chunk) {
        if (!stream.write(chunk)) {
          await new Promise<void>((resolve, reject) => {
            stream.once('drain', resolve);
            stream.once('error', (err) => {
              failed = true;
              reject(err);
            });
          });
        }
      },
    };
  }

  /** Total-bytes over the cap → delete oldest-mtime files until under 90% of it. */
  private async evict(): Promise<void> {
    const entries: { file: string; mtimeMs: number; size: number }[] = [];
    for (const regDir of await readdir(this.dir).catch(() => [] as string[])) {
      const full = join(this.dir, regDir);
      for (const name of await readdir(full).catch(() => [] as string[])) {
        const file = join(full, name);
        const st = await stat(file).catch(() => null);
        if (st?.isFile()) {
          entries.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        }
      }
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    const budget = this.maxBytes * EVICT_FRACTION;
    for (const e of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= budget) {
        break;
      }
      await rm(e.file, { force: true });
      total -= e.size;
    }
  }
}
