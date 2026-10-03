import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_EXPLORER, siteUrl } from './manifest.mjs';
import {
  buildExplorerData,
  changedCodePaths,
  EXPLORER_ROOT,
  parseAgents,
  parseModels,
  parseRouteFamilies,
  REPO_ROOT,
  readAnalysis,
  renderExplorer,
  sourceExcerpt,
  uncommittedCodePaths,
} from './platformExplorer.mjs';
import { assertExplorerPublication } from './verifyPlatformExplorer.mjs';

let data;
let shell;
let analysis;
beforeAll(async () => {
  analysis = await readAnalysis();
  shell = await readFile(join(EXPLORER_ROOT, 'platform-explorer.html'), 'utf8');
  data = await buildExplorerData({ analysis, generatedAt: '2026-08-01T00:00:00.000Z' });
});

function browser(snapshot = data) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(renderExplorer(shell, snapshot), {
    beforeParse(window) {
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
      };
      window.HTMLDialogElement.prototype.close = function () {
        this.open = false;
      };
    },
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: `https://yorch.github.io${siteUrl(PLATFORM_EXPLORER.slug)}`,
    virtualConsole,
  });
  return { dom, errors };
}

function visit(dom, hash) {
  dom.window.location.hash = hash;
  dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));
  return dom.window.document;
}

function input(dom, id, value) {
  const element = dom.window.document.getElementById(id);
  element.value = value;
  element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

describe('platform explorer source extraction', () => {
  it('derives complete inventories from the checked-out code, without frozen counts', async () => {
    const schema = await readFile(
      join(REPO_ROOT, 'packages/shared/src/prisma/schema.prisma'),
      'utf8'
    );
    expect(data.models).toHaveLength([...schema.matchAll(/^model \w+ \{/gm)].length);
    expect(data.models.every((model) => model.fields.length > 0)).toBe(true);
    const seed = await readFile(join(REPO_ROOT, 'packages/shared/src/lib/syncBuiltins.ts'), 'utf8');
    const declaration = seed.match(/export const SWE_AGENTS:[\s\S]*?= \[([\s\S]*?)\n\];/)[1];
    expect(data.agents).toHaveLength([...declaration.matchAll(/\bkey: '/g)].length);
    expect(new Set(data.agents.map((agent) => agent.key)).size).toBe(data.agents.length);
    expect(data.agents.every((agent) => agent.description && agent.name)).toBe(true);
    expect(data.meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(data.nodeTypes.every((type) => typeof type === 'string')).toBe(true);
    expect(data.settings.every((setting) => typeof setting.key === 'string')).toBe(true);
    expect(data.routes.length).toBeGreaterThan(0);
  });

  // Heavy: scans the checked-out repo; a loaded full-suite run overshoots the 5 s default.
  it('matches every anchored excerpt to actual code lines and every graph edge to a node', async () => {
    for (const source of data.sources) {
      const lines = (await readFile(join(REPO_ROOT, source.path), 'utf8')).split('\n');
      const excerpt = lines
        .slice(source.line - 1, source.end)
        .map((line, index) => `${String(source.line + index).padStart(4)}  ${line}`)
        .join('\n');
      expect(source.excerpt, source.id).toBe(excerpt);
      expect(source.path).not.toMatch(/(?:^docs\/|\.md$|\.env)/);
    }
    for (const template of data.templates) {
      expect(template.spec.nodes[template.spec.entry], template.name).toBeDefined();
      for (const [id, edges] of Object.entries(template.edges)) {
        expect(data.nodeTypes).toContain(template.spec.nodes[id].type);
        for (const [, target] of edges) {
          expect(template.spec.nodes[target], `${template.name}/${id} → ${target}`).toBeDefined();
        }
      }
    }
    const sourceIds = new Set(data.sources.map((source) => source.id));
    for (const catalog of ['features', 'concepts', 'usecases', 'limits']) {
      expect(data[catalog].every((item) => item.refs.every((ref) => sourceIds.has(ref)))).toBe(
        true
      );
    }
  }, 30_000);

  // Heavy: runs git against the checked-out repo; a loaded full-suite run overshoots the 5 s default.
  it('detects staged, unstaged, untracked and deleted code before attesting HEAD', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'explorer-git-test-'));
    const file = join(repo, 'packages/example/a.ts');
    const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    try {
      await mkdir(join(repo, 'packages/example'), { recursive: true });
      await writeFile(file, 'export const value = 1;\n');
      git(['init', '--quiet']);
      git(['add', '.']);
      git([
        '-c',
        'user.name=Explorer Test',
        '-c',
        'user.email=explorer@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'Fixture baseline',
      ]);
      expect(uncommittedCodePaths(repo)).toEqual([]);
      await writeFile(
        join(repo, 'packages/example/README.md'),
        'Documentation is not code evidence.'
      );
      expect(uncommittedCodePaths(repo)).toEqual([]);
      await writeFile(file, 'export const value = 2;\n');
      git(['add', 'packages/example/a.ts']);
      expect(uncommittedCodePaths(repo)).toEqual(['packages/example/a.ts']);
      await writeFile(file, 'export const value = 3;\n');
      await writeFile(join(repo, 'packages/example/b.ts'), 'export const other = true;\n');
      expect(uncommittedCodePaths(repo)).toEqual([
        'packages/example/a.ts',
        'packages/example/b.ts',
      ]);
      await rm(file);
      expect(uncommittedCodePaths(repo)).toEqual([
        'packages/example/a.ts',
        'packages/example/b.ts',
      ]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  }, 30_000);

  it('detects added, modified and removed code without needing Git history', () => {
    expect(changedCodePaths({ a: 'old', b: 'old' }, { a: 'new', c: 'new' })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('relocates citations when lines move and fails on ambiguous or missing anchors', () => {
    const source = { anchor: 'function current()', id: 'test', lines: 2, path: 'packages/test.ts' };
    expect(sourceExcerpt('\n\nfunction current() {}\nreturn 1;', source).line).toBe(3);
    expect(() => sourceExcerpt('function removed() {}', source)).toThrow('match once');
    expect(() => sourceExcerpt('function current() {}\nfunction current() {}', source)).toThrow(
      'match once'
    );
    expect(() => renderExplorer('no marker', data)).toThrow('exactly one');
  });

  it('extracts Prisma relationships, enum/scalar fields, arrays and vector types', () => {
    const schema = `model Parent {
  id String @id
  children Child[]
  embedding Unsupported("vector(1536)")?
  status Status
  @@map("parents")
}
model Child {
  id String @id
  parent Parent? @relation(fields: [parentId], references: [id])
  parentId String?
}
`;
    const models = parseModels(schema, { modelDescriptions: {}, modelGroups: {} });
    expect(models[0].table).toBe('parents');
    expect(models[0].fields.find((field) => field.name === 'children').relation).toBe('Child');
    expect(models[0].fields.find((field) => field.name === 'embedding').type).toBe(
      'Unsupported("vector(1536)")?'
    );
    expect(models[0].fields.find((field) => field.name === 'status').relation).toBeNull();
    expect(models[1].fields.find((field) => field.name === 'parent').relation).toBe('Parent');
    expect(models[0].group).toBe('Unclassified');
  });

  it('extracts literal seed metadata without executing bootstrap code', () => {
    const seed = `export const SWE_AGENTS: AgentSeed[] = [
  {
    key: 'example',
    name: 'Example',
    description:
      'A reviewer\\'s role',
    modelSpec: 'provider/model',
  },
];`;
    expect(parseAgents(seed)[0]).toMatchObject({
      description: "A reviewer's role",
      key: 'example',
      modelSpec: 'provider/model',
    });
    expect(() => parseAgents(seed.replace("key: 'example'", 'key: runtimeValue'))).toThrow();
  });

  it('retains compatibility prefixes and literal route declarations', () => {
    const gateway = `import { exampleRoutes } from './routes/example.js';
app.register(exampleRoutes, { prefix: '/api/v1/example' });
app.register(exampleRoutes, { prefix: '/compat/example' });`;
    const routes = parseRouteFamilies(gateway, {
      example: "fastify.get('/read', handler);\nfastify.post('/write', handler);",
    });
    expect(routes[0].prefixes).toEqual(['/api/v1/example', '/compat/example']);
    expect(routes[0].declarations.map((route) => route.method)).toEqual(['GET', 'POST']);
  });

  // Heavy: rebuilds the snapshot from the checked-out repo; a loaded full-suite run overshoots the 5 s default.
  it('flags changed evidence rather than advancing the human-review attestation', async () => {
    const changed = structuredClone(analysis);
    const path = changed.sources[0].path;
    changed.sourceHashes[path] = 'unreviewed';
    const snapshot = await buildExplorerData({ analysis: changed, commit: data.meta.commit });
    expect(snapshot.meta.changedSources).toContain(path);
    expect(snapshot.meta.reviewedCommit).toBe(analysis.reviewedCommit);
    const { dom, errors } = browser(snapshot);
    expect(dom.window.document.querySelector('[role="status"]').textContent).toContain(
      'Narrative review needed'
    );
    expect(errors).toEqual([]);
    dom.window.close();
  }, 30_000);
});

describe('public explorer interactions', () => {
  it('checks rendered publication links and rejects a double-prefixed sidebar route', () => {
    const landing = '<a href="/auto-swe/platform-explorer/">Explorer</a>';
    const explorer = renderExplorer(shell, data);
    expect(() => assertExplorerPublication({ docs: landing, explorer, landing })).not.toThrow();
    expect(() =>
      assertExplorerPublication({
        docs: '<a href="/auto-swe/auto-swe/platform-explorer/">Explorer</a>',
        explorer,
        landing,
      })
    ).toThrow('docs: missing explorer link');
    expect(() =>
      assertExplorerPublication({ docs: landing, explorer: '<html></html>', landing })
    ).toThrow('Missing inert explorer snapshot');
  });
  // Heavy: boots the explorer in jsdom; a loaded full-suite run overshoots the 5 s default.
  it('runs all nine views offline and produces public base-path and pinned GitHub links', () => {
    const { dom, errors } = browser();
    for (const hash of [
      '#overview',
      '#architecture',
      '#usecases',
      '#workflows',
      '#concepts',
      '#models',
      '#features',
      '#governance',
      '#sources',
    ]) {
      const document = visit(dom, hash);
      expect(document.querySelector('main h1'), hash).not.toBeNull();
      expect(document.querySelector('#nav [aria-current="page"]').hash).toBe(hash);
      for (const link of document.querySelectorAll('main a[href*="/blob/"]')) {
        expect(link.href).toContain(`${data.meta.repoUrl}/blob/${data.meta.commit}/`);
      }
    }
    expect(dom.window.document.getElementById('site-home').pathname).toBe('/auto-swe/');
    expect(dom.window.document.querySelectorAll('a[href^="../"]')).toHaveLength(0);
    expect(
      dom.window.document.querySelectorAll('script[src],link[href],iframe,form[action]')
    ).toHaveLength(0);
    expect(errors).toEqual([]);
    dom.window.close();
  }, 30_000);

  // Heavy: boots the explorer in jsdom; a loaded full-suite run overshoots the 5 s default.
  it('filters schema fields, navigates relations and walks real graph edges', () => {
    const { dom, errors } = browser();
    let document = visit(dom, '#models/WorkflowRun');
    input(dom, 'view-filter', 'pinnedSettings');
    expect(document.querySelector('.listing').textContent).toContain('WorkflowRun');
    expect(document.querySelectorAll('.listing .listitem').length).toBeLessThan(data.models.length);
    expect(document.querySelector('.detail a[href^="#models/"]')).not.toBeNull();
    document = visit(dom, '#workflows/default-engineering');
    const template = data.templates.find((item) => item.name === 'default-engineering');
    expect(document.querySelectorAll('.graphnode')).toHaveLength(
      Object.keys(template.spec.nodes).length
    );
    const edge = document.querySelector('[data-edge]');
    const target = edge.dataset.edge;
    edge.click();
    expect(document.querySelector('.path').textContent).toContain(target);
    document.querySelector('[data-reset-flow]').click();
    expect(document.querySelector('.path').textContent.trim()).toBe(template.spec.entry);
    const graphNode = document.querySelector('.graphnode');
    graphNode.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })
    );
    expect(errors).toEqual([]);
    dom.window.close();
  }, 30_000);

  // Heavy: boots the explorer in jsdom; a loaded full-suite run overshoots the 5 s default.
  it('opens anchored evidence, searches, escapes input and toggles theme', () => {
    const { dom, errors } = browser();
    let document = visit(dom, '#features');
    const sourceButton = document.querySelector('[data-source]');
    const source = data.sources.find((item) => item.id === sourceButton.dataset.source);
    sourceButton.click();
    expect(document.querySelector('#evidence').open).toBe(true);
    expect(document.querySelector('#evidence-code').textContent).toBe(source.excerpt);
    expect(document.querySelector('#evidence-links a').href).toContain(
      `/blob/${data.meta.commit}/${source.path}#L${source.line}`
    );
    document.querySelector('#close-evidence').click();
    expect(document.querySelector('#evidence').open).toBe(false);
    document = visit(dom, '#search/pinnedSettings');
    expect(document.querySelectorAll('.result').length).toBeGreaterThan(0);
    document = visit(dom, '#search/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E');
    expect(document.querySelector('main img')).toBeNull();
    expect(document.querySelector('main').textContent).toContain('<img src=x onerror=alert(1)>');
    const before = document.documentElement.classList.contains('light');
    document.querySelector('#theme').click();
    expect(document.documentElement.classList.contains('light')).not.toBe(before);
    expect(errors).toEqual([]);
    dom.window.close();
  }, 30_000);

  // Heavy: boots the explorer in jsdom; a loaded full-suite run overshoots the 5 s default.
  it('marks local previews and labels committed links before uncommitted edits', () => {
    const snapshot = structuredClone(data);
    snapshot.meta.dirtySourcePaths = ['packages/shared/src/prisma/schema.prisma'];
    const { dom, errors } = browser(snapshot);
    const document = visit(dom, '#models/WorkflowRun');
    expect(document.querySelector('[role="status"]').textContent).toContain('Local source preview');
    expect(document.querySelector('.detail a[href*="/blob/"]').textContent).toContain(
      'before local edits'
    );
    expect(errors).toEqual([]);
    dom.window.close();
  }, 30_000);

  // Heavy: boots the explorer in jsdom; a loaded full-suite run overshoots the 5 s default.
  it('keeps hostile markup and template sequences inert inside snapshot text', () => {
    const hostile = `</template><script>window.injected = true</script> & \${unsafe}`;
    const snapshot = structuredClone(data);
    snapshot.sources[0].excerpt = hostile;
    const { dom, errors } = browser(snapshot);
    const decoded = JSON.parse(
      dom.window.document.getElementById('platform-data').content.textContent
    );
    expect(decoded.sources[0].excerpt).toBe(hostile);
    expect(dom.window.injected).toBeUndefined();
    expect(errors).toEqual([]);
    dom.window.close();
  }, 30_000);
});
