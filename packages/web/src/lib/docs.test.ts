import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchIndex } from './docSearch';
import { deriveDescription, loadDocSearchIndex, orderDocs } from './docs';

// listDocs and getDoc read the docs directory through these two calls. Mocking them keeps the
// index build independent of the process cwd and of the real docs/ contents.
vi.mock('node:fs/promises', () => ({ readdir: vi.fn(), readFile: vi.fn() }));

const MEMO_KEY = Symbol.for('auto-swe.docSearchIndex');
const memo = globalThis as unknown as { [MEMO_KEY]?: Promise<SearchIndex> };
const readdirMock = vi.mocked(readdir);
const readFileMock = vi.mocked(readFile);
const GUIDE = '# Guide\n\nSome prose about the guide.\n\n## Setup\n\nRun the setup step.\n';

beforeEach(() => {
  delete memo[MEMO_KEY];
  readdirMock.mockReset();
  readFileMock.mockReset();
  readdirMock.mockResolvedValue(['guide.md'] as never);
  readFileMock.mockResolvedValue(GUIDE as never);
});

afterEach(() => {
  delete memo[MEMO_KEY];
});

describe('deriveDescription', () => {
  it('keeps underscores inside words and drops emphasis ones', () => {
    expect(deriveDescription('# T\n\nSet AUTO_SWE_TOKEN to _sign in_ and __go__.')).toBe(
      'Set AUTO_SWE_TOKEN to sign in and go.'
    );
  });

  it("keeps an image's alt text and drops its path", () => {
    expect(deriveDescription('# T\n\n![Diagram](./a_b.png) Overview of it.')).toBe(
      'Diagram Overview of it.'
    );
  });

  it('skips front matter, headings and horizontal rules', () => {
    expect(deriveDescription('---\ntitle: x\n---\n# Title\n\n---\n\nFirst paragraph.')).toBe(
      'First paragraph.'
    );
    expect(deriveDescription('# Title\n---\nText here.')).toBe('Text here.');
  });

  it('accepts blockquote text and joins the paragraph lines', () => {
    expect(deriveDescription('# T\n\n> Guidelines for any\n> agent working here.\n\nNext')).toBe(
      'Guidelines for any agent working here.'
    );
  });

  it('strips links and emphasis', () => {
    expect(deriveDescription('# T\n\nSee [the **map**](./x.md) and `code`.')).toBe(
      'See the map and code.'
    );
  });

  it('cuts long text at a word boundary with an ellipsis', () => {
    const out = deriveDescription(`# T\n\n${'word '.repeat(60)}`);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(141);
    expect(out).not.toMatch(/wor…$/);
  });

  it('returns an empty string when there is no prose', () => {
    expect(deriveDescription('# Only a heading')).toBe('');
  });
});

describe('orderDocs', () => {
  it('pins Overview, Quickstart and Product overview first, then sorts by title', () => {
    const doc = (slug: string, title: string) => ({ description: '', slug, title });
    const out = orderDocs([
      doc('agents', 'Agents'),
      doc('product-overview', 'Product overview'),
      doc('architecture', 'Architecture'),
      doc('quickstart', 'Quickstart'),
      doc('README', 'Overview'),
    ]);
    expect(out.map((d) => d.slug)).toEqual([
      'README',
      'quickstart',
      'product-overview',
      'agents',
      'architecture',
    ]);
  });
});

describe('loadDocSearchIndex', () => {
  it('shares one build between callers, so a start-up warm-up serves the first search', async () => {
    const first = loadDocSearchIndex();
    expect(loadDocSearchIndex()).toBe(first);
    const index = await first;
    expect(index.docs.map((d) => d.slug)).toEqual(['guide']);
    expect(readdirMock).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failed build: the next call retries and succeeds', async () => {
    readdirMock.mockRejectedValueOnce(new Error('unreadable'));
    const failed = loadDocSearchIndex();
    await expect(failed).rejects.toThrow('unreadable');
    expect(memo[MEMO_KEY]).toBeUndefined();

    const retry = loadDocSearchIndex();
    expect(retry).not.toBe(failed);
    const index = await retry;
    expect(index.docs.map((d) => d.slug)).toEqual(['guide']);
    expect(readdirMock).toHaveBeenCalledTimes(2);
  });

  it('a failing old build does not clear a newer build stored in the memo', async () => {
    let rejectOld: (error: Error) => void = () => {
      throw new Error('rejectOld was not captured');
    };
    readdirMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }) as never
    );
    const old = loadDocSearchIndex();

    // Stand in for a newer build taking the memo slot before the old build's rejection
    // handler runs; the newer build is a real one, from the second readdir call.
    delete memo[MEMO_KEY];
    const newer = loadDocSearchIndex();
    expect(newer).not.toBe(old);

    rejectOld(new Error('stale build failed'));
    await expect(old).rejects.toThrow('stale build failed');

    expect(memo[MEMO_KEY]).toBe(newer);
    expect(loadDocSearchIndex()).toBe(newer);
    const index = await newer;
    expect(index.docs.map((d) => d.slug)).toEqual(['guide']);
  });
});
