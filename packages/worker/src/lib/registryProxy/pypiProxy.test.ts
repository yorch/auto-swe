import { buildPypiAllowlist } from '@auto-swe/shared/lib/pypiAllowlist';
import { describe, expect, it } from 'vitest';
import {
  fileIdFor,
  filterAllowedFiles,
  parsePypiPath,
  parseSimpleIndex,
  renderSimpleIndex,
} from './pypiProxy.js';

const BASE = 'https://pypi.test/simple/flask/';
const SHA = 'a'.repeat(64);

describe('parsePypiPath', () => {
  it('reads the index and file shapes, normalising the project', () => {
    expect(parsePypiPath('/simple/Flask/')).toEqual({ kind: 'index', project: 'flask' });
    expect(parsePypiPath('/simple/zope.interface/')).toEqual({
      kind: 'index',
      project: 'zope-interface',
    });
    expect(parsePypiPath('/simple/flask')).toEqual({ kind: 'index', project: 'flask' });
    const fileId = 'a1'.repeat(16);
    expect(parsePypiPath(`/files/${fileId}/flask-3.0.0-py3-none-any.whl`)).toEqual({
      fileId,
      filename: 'flask-3.0.0-py3-none-any.whl',
      kind: 'file',
    });
    expect(parsePypiPath(`/files/${fileId}/pkg-1!2.0+local.1.tar.gz`)).not.toBeNull();
  });

  it('refuses everything else', () => {
    const fileId = 'a1'.repeat(16);
    for (const rest of [
      '',
      '/',
      '/simple',
      '/simple/',
      '//simple/flask/',
      '/simple//',
      '/simple/flask/extra',
      '/simple/fl%61sk/',
      '/simple/fl\\ask/',
      '/simple/flask/?x=1',
      '/simple/flask#x',
      '/simple/-flask/',
      '/simple/../',
      '/simple/./',
      '/simple/a b/',
      `/simple/${'a'.repeat(201)}/`,
      '/files',
      '/files/short/x.whl',
      `/files/${fileId}`,
      `/files/${fileId}/`,
      `/files/${fileId.toUpperCase()}/x.whl`,
      `/files/${fileId}/a/b.whl`,
      `/files/${fileId}/a%2fb.whl`,
      `/files/${fileId}/a..b.whl`,
      `/files/${fileId}/a\\b.whl`,
      `/files/${fileId}/${'a'.repeat(301)}`,
      `/files/${fileId}/x.whl?x=1`,
      '/other/flask/',
    ]) {
      expect(parsePypiPath(rest), rest).toBeNull();
    }
  });

  it('is linear on a long hostile path', () => {
    const start = performance.now();
    parsePypiPath(`/simple/${'-'.repeat(2_000_000)}/`);
    parsePypiPath(`/files/${'a'.repeat(32)}/${'.'.repeat(2_000_000)}`);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('fileIdFor', () => {
  it('is 32 hex characters, and depends on both the registry and the URL', () => {
    const id = fileIdFor('reg-1', 'https://f.test/a.whl');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(fileIdFor('reg-1', 'https://f.test/a.whl')).toBe(id);
    expect(fileIdFor('reg-2', 'https://f.test/a.whl')).not.toBe(id);
    expect(fileIdFor('reg-1', 'https://f.test/b.whl')).not.toBe(id);
  });
});

describe('parseSimpleIndex: PEP 691 JSON', () => {
  it('reads files, resolves relative URLs and prefers sha256', () => {
    const body = JSON.stringify({
      files: [
        {
          filename: 'flask-3.0.0-py3-none-any.whl',
          hashes: { md5: 'b'.repeat(32), sha256: SHA.toUpperCase() },
          'requires-python': '>=3.8',
          url: '../../packages/flask-3.0.0-py3-none-any.whl',
          yanked: 'broken',
        },
        {
          filename: 'flask-2.0.0.tar.gz',
          hashes: { md5: 'b'.repeat(32) },
          url: 'https://files.test/flask-2.0.0.tar.gz',
          yanked: true,
        },
        {
          filename: 'flask-1.0.0.tar.gz',
          url: 'https://files.test/flask-1.0.0.tar.gz',
          yanked: false,
        },
      ],
    });
    expect(parseSimpleIndex(body, 'application/vnd.pypi.simple.v1+json', BASE)).toEqual([
      {
        filename: 'flask-3.0.0-py3-none-any.whl',
        hash: `sha256=${SHA}`,
        requiresPython: '>=3.8',
        url: 'https://pypi.test/packages/flask-3.0.0-py3-none-any.whl',
        yanked: 'broken',
      },
      {
        filename: 'flask-2.0.0.tar.gz',
        hash: `md5=${'b'.repeat(32)}`,
        url: 'https://files.test/flask-2.0.0.tar.gz',
        yanked: true,
      },
      { filename: 'flask-1.0.0.tar.gz', url: 'https://files.test/flask-1.0.0.tar.gz' },
    ]);
  });

  it('drops bad entries and refuses a document that is not an index', () => {
    const good = { filename: 'flask-1.0.0.tar.gz', url: 'https://f.test/flask-1.0.0.tar.gz' };
    const body = JSON.stringify({
      files: [
        good,
        null,
        'x',
        { filename: 'flask-1.0.0.tar.gz' },
        { filename: 'a/b-1.0.tar.gz', url: 'https://f.test/x' },
        { filename: 'flask-1.0.0.egg', url: 'https://f.test/x' },
        { filename: 'flask-1.0.0.tar.gz', url: 'javascript:alert(1)' },
        { filename: 'flask-1.0.0.tar.gz', url: 'ftp://f.test/x' },
        { filename: 'flask-1.0.0.tar.gz', url: 'https://user:pw@f.test/x' },
        { filename: 'flask-1.0.0.tar.gz', url: 'https://user@f.test/x' },
        {
          filename: 'flask-1.0.0.tar.gz',
          'requires-python': 'x'.repeat(4001),
          url: 'https://f.test/x',
        },
      ],
    });
    expect(parseSimpleIndex(body, 'application/vnd.pypi.simple.v1+json', BASE)).toEqual([good]);
    for (const bad of ['{', '[]', '{"files":{}}', '"x"', 'null']) {
      expect(parseSimpleIndex(bad, 'application/vnd.pypi.simple.v1+json', BASE), bad).toBeNull();
    }
  });
});

describe('parseSimpleIndex: PEP 503 HTML', () => {
  const html = (anchors: string) => `<!DOCTYPE html><html><body>${anchors}</body></html>`;

  it('reads anchors with their hash fragment, requires-python and yanked', () => {
    const body = html(
      `<a href="https://files.test/flask-3.0.0-py3-none-any.whl#sha256=${SHA}" data-requires-python="&gt;=3.8" data-core-metadata="sha256=${SHA}">flask-3.0.0-py3-none-any.whl</a><br>
       <a href='/packages/flask-2.0.0.tar.gz' data-yanked="no &quot;good&quot;">flask-2.0.0.tar.gz</a>
       <a href=flask-1.0.0.tar.gz#md5=${'c'.repeat(32)} data-yanked>flask-1.0.0.tar.gz</A>`
    );
    expect(parseSimpleIndex(body, 'text/html; charset=utf-8', BASE)).toEqual([
      {
        filename: 'flask-3.0.0-py3-none-any.whl',
        hash: `sha256=${SHA}`,
        requiresPython: '>=3.8',
        url: 'https://files.test/flask-3.0.0-py3-none-any.whl',
      },
      {
        filename: 'flask-2.0.0.tar.gz',
        url: 'https://pypi.test/packages/flask-2.0.0.tar.gz',
        yanked: 'no "good"',
      },
      {
        filename: 'flask-1.0.0.tar.gz',
        hash: `md5=${'c'.repeat(32)}`,
        url: 'https://pypi.test/simple/flask/flask-1.0.0.tar.gz',
        yanked: '',
      },
    ]);
  });

  it('accepts the v1 HTML content type and sniffs a missing one', () => {
    const body = html('<a href="https://f.test/flask-1.0.0.tar.gz">flask-1.0.0.tar.gz</a>');
    expect(parseSimpleIndex(body, 'application/vnd.pypi.simple.v1+html', BASE)).toHaveLength(1);
    expect(parseSimpleIndex(body, '', BASE)).toHaveLength(1);
    expect(parseSimpleIndex('{"files":[]}', '', BASE)).toEqual([]);
    expect(parseSimpleIndex('plain text', 'text/plain', BASE)).toBeNull();
    expect(parseSimpleIndex('\u0089PNG\r\n', 'image/png', BASE)).toBeNull();
  });

  it('decodes entities once and drops a filename that decodes to something unusable', () => {
    const body = html(
      `<a href="https://f.test/flask-1.0.0.tar.gz">flask&#45;1.0.0.tar.gz</a>
       <a href="https://f.test/x">flask-1.0.0&#47;..&#47;x.tar.gz</a>
       <a href="https://f.test/y">flask-2.0.0&amp;#45;x.tar.gz</a>
       <a href="https://f.test/z">flask-3.0.0.tar.gz&#0;</a>
       <a href="https://f.test/z2">flask-4.0.0.tar.gz&#x110000;</a>`
    );
    expect(parseSimpleIndex(body, 'text/html', BASE)?.map((f) => f.filename)).toEqual([
      'flask-1.0.0.tar.gz',
    ]);
  });

  it('drops hostile hrefs and filenames, keeps the good anchors around them', () => {
    const body = html(
      `<a href="javascript:alert(1)">flask-1.0.0.tar.gz</a>
       <a href="data:text/plain,x">flask-1.0.1.tar.gz</a>
       <a href="https://u:p@f.test/flask-1.0.2.tar.gz">flask-1.0.2.tar.gz</a>
       <a href="https://f.test/a">a/b-1.0.tar.gz</a>
       <a href="https://f.test/b">../flask-1.0.3.tar.gz</a>
       <a>flask-1.0.4.tar.gz</a>
       <a href="https://f.test/c">not-a-distribution.txt</a>
       <a href="${'h'.repeat(4001)}">flask-1.0.5.tar.gz</a>
       <a href="https://f.test/d" data-requires-python="${'x'.repeat(4001)}">flask-1.0.6.tar.gz</a>
       <abbr href="https://f.test/e">flask-1.0.7.tar.gz</abbr>
       <!-- <a href="https://f.test/f">flask-1.0.8.tar.gz</a> -->
       <a href="https://f.test/ok">flask-9.9.9.tar.gz</a>`
    );
    expect(parseSimpleIndex(body, 'text/html', BASE)?.map((f) => f.filename)).toEqual([
      'flask-9.9.9.tar.gz',
    ]);
  });

  it('survives unclosed anchors, unterminated quotes and a body with no anchors', () => {
    expect(
      parseSimpleIndex(
        '<a href="https://f.test/flask-1.0.0.tar.gz">flask-1.0.0.tar.gz',
        'text/html',
        BASE
      )
    ).toEqual([
      {
        filename: 'flask-1.0.0.tar.gz',
        url: 'https://f.test/flask-1.0.0.tar.gz',
      },
    ]);
    expect(parseSimpleIndex('<a href="https://f.test/x', 'text/html', BASE)).toBeNull();
    expect(parseSimpleIndex('<a href="x" ', 'text/html', BASE)).toBeNull();
    expect(parseSimpleIndex('<html><body>nothing</body></html>', 'text/html', BASE)).toBeNull();
    expect(parseSimpleIndex('<!-- never closed', 'text/html', BASE)).toBeNull();
  });

  it('is linear on huge and pathological bodies', () => {
    const start = performance.now();
    for (const body of [
      `<a ${'a="b" '.repeat(300_000)}>x</a>`,
      '<a '.repeat(500_000),
      `<a href=${'x'.repeat(5_000_000)}>y</a>`,
      `<a href="x">${'&amp;'.repeat(400_000)}</a>`,
      '<'.repeat(2_000_000),
      `<a href="${'&'.repeat(3_000_000)}`,
      `<a ${'='.repeat(1_000_000)}>`,
    ]) {
      parseSimpleIndex(body, 'text/html', BASE);
    }
    expect(performance.now() - start).toBeLessThan(5000);
  });

  it('caps the number of files at 100,000', () => {
    const one = '<a href="https://f.test/flask-1.0.0.tar.gz">flask-1.0.0.tar.gz</a>';
    expect(parseSimpleIndex(one.repeat(100_050), 'text/html', BASE)).toHaveLength(100_000);
  });
});

describe('renderSimpleIndex', () => {
  it('renders PEP 503 HTML with every attribute and text escaped', () => {
    const out = renderSimpleIndex('fl"ask', [
      {
        filename: 'flask-3.0.0.tar.gz',
        hash: `sha256=${SHA}`,
        href: '/pypi/t/r/files/id/flask-3.0.0.tar.gz',
        requiresPython: '>=3.8,<4"&\'',
        yanked: '<b>"x"</b>',
      },
      { filename: 'flask-2.0.0.tar.gz', href: '/p/2', yanked: true },
      { filename: 'flask-1.0.0.tar.gz', href: '/p/1' },
    ]);
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).toContain('<meta name="pypi:repository-version" content="1.0">');
    expect(out).toContain('Links for fl&quot;ask');
    expect(out).toContain(
      `<a href="/pypi/t/r/files/id/flask-3.0.0.tar.gz#sha256=${SHA}" data-requires-python="&gt;=3.8,&lt;4&quot;&amp;&#39;" data-yanked="&lt;b&gt;&quot;x&quot;&lt;/b&gt;">flask-3.0.0.tar.gz</a><br>`
    );
    expect(out).toContain('<a href="/p/2" data-yanked="">flask-2.0.0.tar.gz</a><br>');
    expect(out).toContain('<a href="/p/1">flask-1.0.0.tar.gz</a><br>');
    expect(out).not.toContain('data-core-metadata');
    expect(out).not.toContain('data-dist-info-metadata');
  });

  it('round-trips through the parser', () => {
    const out = renderSimpleIndex('flask', [
      {
        filename: 'flask-3.0.0-py3-none-any.whl',
        hash: `sha256=${SHA}`,
        href: '/pypi/t/r/files/id/flask-3.0.0-py3-none-any.whl',
        requiresPython: '>=3.8',
        yanked: 'a & b',
      },
    ]);
    expect(parseSimpleIndex(out, 'text/html', 'http://proxy/pypi/t/r/simple/flask/')).toEqual([
      {
        filename: 'flask-3.0.0-py3-none-any.whl',
        hash: `sha256=${SHA}`,
        requiresPython: '>=3.8',
        url: 'http://proxy/pypi/t/r/files/id/flask-3.0.0-py3-none-any.whl',
        yanked: 'a & b',
      },
    ]);
  });
});

describe('filterAllowedFiles', () => {
  const allowlist = buildPypiAllowlist([
    { name: 'flask', version: '3.0.0' },
    { name: 'zope-interface', version: '6.0' },
  ]);
  const f = (filename: string) => ({ filename });

  it('keeps pinned versions of the project, in any spelling, and counts the rest', () => {
    const files = [
      f('flask-3.0.0-py3-none-any.whl'),
      f('Flask-3.0.0.tar.gz'),
      f('flask-3.0.1-py3-none-any.whl'),
      f('werkzeug-3.0.0-py3-none-any.whl'),
      f('flask-3.0.0.egg'),
    ];
    expect(filterAllowedFiles(files, allowlist, 'flask')).toEqual({
      dropped: 3,
      kept: [files[0], files[1]],
    });
    const zope = [
      f('zope.interface-6.0-cp311-cp311-linux_x86_64.whl'),
      f('zope.interface-5.0.tar.gz'),
    ];
    expect(filterAllowedFiles(zope, allowlist, 'Zope.Interface')).toEqual({
      dropped: 1,
      kept: [zope[0]],
    });
  });

  it('keeps nothing for a project the allowlist lacks', () => {
    expect(filterAllowedFiles([f('django-4.0.tar.gz')], allowlist, 'django')).toEqual({
      dropped: 1,
      kept: [],
    });
  });
});
