import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTING_DEFINITIONS } from '../../packages/shared/src/config/registry.ts';
import {
  NodeSchema,
  nodeEdges,
  WorkflowSpecSchema,
} from '../../packages/shared/src/workflow/spec.ts';
import { listAllSteps } from '../../packages/shared/src/workflow/stepRegistry.ts';
import { BUILTIN_TEMPLATES } from '../../packages/shared/src/workflow/templates/index.ts';
import { PLATFORM_EXPLORER, REPO_URL, siteUrl } from './manifest.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const EXPLORER_ROOT = join(REPO_ROOT, 'site/src/explorer');
const OUTPUT = join(REPO_ROOT, 'site/public/platform-explorer/index.html');
const SCHEMA = 'packages/shared/src/prisma/schema.prisma';
const SEED = 'packages/shared/src/lib/syncBuiltins.ts';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const isCodePath = (path) =>
  /\.(?:ts|tsx|js|mjs|prisma|json|sql|ya?ml)$/.test(path) || path.endsWith('/Dockerfile');

/** Fail on a missing or ambiguous locator rather than silently citing unrelated lines. */
export function sourceExcerpt(text, source) {
  const position = text.indexOf(source.anchor);
  if (position < 0 || position !== text.lastIndexOf(source.anchor)) {
    throw new Error(`${source.id}: evidence anchor must match once in ${source.path}`);
  }
  const lines = text.split('\n');
  const anchorLine = text.slice(0, position).split('\n').length;
  const line = Math.max(1, anchorLine - (source.before ?? 0));
  const end = Math.min(lines.length, line + source.lines - 1);
  return {
    end,
    excerpt: lines
      .slice(line - 1, end)
      .map((value, index) => `${String(line + index).padStart(4)}  ${value}`)
      .join('\n'),
    id: source.id,
    line,
    path: source.path,
    title: source.title,
  };
}

/** Read declarations only; never import the DB-connected bootstrap module. */
export function parseAgents(seed) {
  const declaration = seed.match(/export const SWE_AGENTS:[\s\S]*?= \[([\s\S]*?)\n\];/);
  if (!declaration) {
    throw new Error('Cannot find SWE_AGENTS; update the static extractor after reviewing the seed');
  }
  const records = [...declaration[1].matchAll(/\n {2}\{([\s\S]*?)\n {2}\},/g)];
  const agents = records.map((record) => {
    const fields = {};
    for (const name of ['key', 'name', 'description', 'modelSpec', 'inheritsModelFrom']) {
      const match = record[1].match(new RegExp(`(?:^|\\n)\\s*${name}:\\s*'((?:\\\\.|[^'\\\\])*)'`));
      if (match) {
        fields[name] = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      }
    }
    if (
      !fields.key ||
      !fields.name ||
      !fields.description ||
      (!fields.modelSpec && !fields.inheritsModelFrom)
    ) {
      throw new Error('An agent seed no longer uses literal metadata; update parseAgents');
    }
    return {
      ...fields,
      line: seed.slice(0, seed.indexOf(record[0])).split('\n').length,
    };
  });
  const keyCount = [...declaration[1].matchAll(/^\s+key:/gm)].length;
  if (agents.length === 0 || agents.length !== keyCount) {
    throw new Error('Agent extraction is incomplete; refusing a partial published catalog');
  }
  return agents;
}

export function parseModels(schema, analysis) {
  const blocks = [...schema.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)];
  const names = new Set(blocks.map((block) => block[1]));
  if (names.size === 0) {
    throw new Error('No Prisma models found');
  }
  return blocks.map((block) => {
    const fields = block[2]
      .split('\n')
      .map((line) => line.trim())
      .map((line) => line.match(/^(\w+)\s+(Unsupported\("[^"]+"\)\??|[\w?[\]]+)\s*(.*)$/))
      .filter(Boolean)
      .map((field) => {
        const target = field[2].replace(/[?[\]]/g, '');
        return {
          attributes: field[3],
          name: field[1],
          relation: names.has(target) ? target : null,
          type: field[2],
        };
      });
    return {
      constraints: block[2]
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('@@')),
      description:
        analysis.modelDescriptions[block[1]] ??
        'Schema entity; inspect its fields and relationships. Narrative classification needs review.',
      fields,
      group:
        Object.entries(analysis.modelGroups).find(([, members]) =>
          members.includes(block[1])
        )?.[0] ?? 'Unclassified',
      line: schema.slice(0, block.index).split('\n').length,
      name: block[1],
      table: block[2].match(/@@map\("([^"]+)"\)/)?.[1] ?? block[1],
    };
  });
}

/** Literal registrations/declarations only, not a runtime OpenAPI inventory. */
export function parseRouteFamilies(gateway, routeFiles) {
  const imports = new Map();
  for (const match of gateway.matchAll(/import \{ ([^}]+) \} from '\.\/routes\/([^']+)\.js';/g)) {
    for (const name of match[1].split(',')) {
      imports.set(name.trim(), match[2]);
    }
  }
  const mounts = new Map();
  for (const match of gateway.matchAll(/app\.register\((\w+), \{ prefix: '([^']+)' \}\)/g)) {
    const module = imports.get(match[1]);
    if (module) {
      const prefixes = mounts.get(module) ?? [];
      prefixes.push(match[2]);
      mounts.set(module, prefixes);
    }
  }
  return [...mounts.entries()].sort().map(([name, prefixes]) => {
    const text = routeFiles[name];
    if (text === undefined) {
      throw new Error(`Mounted route module not found: ${name}`);
    }
    return {
      declarations: [
        ...text.matchAll(
          /fastify\.(get|post|put|patch|delete)\s*(?:<[^;]*?>)?\s*\(\s*['"]([^'"]+)['"]/g
        ),
      ].map((match) => ({
        line: text.slice(0, match.index).split('\n').length,
        method: match[1].toUpperCase(),
        path: match[2],
      })),
      name,
      path: `packages/gateway/src/routes/${name}.ts`,
      prefixes,
    };
  });
}

/** No markup/template parser should reinterpret code inside the generated JSON text. */
export function serializeSnapshot(data) {
  return JSON.stringify(data, null, 2)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;');
}

export function renderExplorer(template, data) {
  const marker = '__PLATFORM_DATA__';
  if (template.split(marker).length !== 2) {
    throw new Error('Explorer shell must contain exactly one snapshot marker');
  }
  return template.replace(marker, () => serializeSnapshot(data));
}

export async function readAnalysis() {
  try {
    return JSON.parse(await readFile(join(EXPLORER_ROOT, 'analysis.json'), 'utf8'));
  } catch (cause) {
    throw new Error('Cannot load the authored platform analysis', { cause });
  }
}

function assertEvidencePath(path) {
  if (
    path.includes('..') ||
    path.startsWith('/') ||
    (!path.startsWith('packages/') && path !== 'docker-compose.app.yml') ||
    !/\.(?:ts|tsx|mjs|yml|prisma)$/.test(path)
  ) {
    throw new Error(`Not an allowlisted code-evidence path: ${path}`);
  }
}

/** Tracked code plus untracked code previews; ignore docs, credentials and build output. */
export async function fingerprintCode() {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'packages',
      'docker-compose.app.yml',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
    .split('\0')
    .filter(isCodePath);
  const hashes = {};
  for (const path of [...new Set(paths)].sort()) {
    try {
      hashes[path] = digest(await readFile(join(REPO_ROOT, path)));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      // A locally deleted code file is absent from the current fingerprint.
    }
  }
  return hashes;
}

/** Include staged changes too: ls-files --modified alone only compares with the index. */
export function uncommittedCodePaths(repo = REPO_ROOT) {
  const options = { cwd: repo, encoding: 'utf8' };
  const tracked = execFileSync(
    'git',
    ['diff', '--name-only', '-z', 'HEAD', '--', 'packages', 'docker-compose.app.yml'],
    options
  );
  const untracked = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--others',
      '--exclude-standard',
      '--',
      'packages',
      'docker-compose.app.yml',
    ],
    options
  );
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(isCodePath))].sort();
}

export function changedCodePaths(reviewed, current) {
  return [...new Set([...Object.keys(reviewed), ...Object.keys(current)])]
    .filter((path) => reviewed[path] !== current[path])
    .sort();
}

async function workflowSources() {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        files.push({ path: relative(REPO_ROOT, path), text: await readFile(path, 'utf8') });
      }
    }
  };
  await walk(join(REPO_ROOT, 'packages/shared/src/workflow'));
  return files;
}

export async function buildExplorerData({ analysis, commit, generatedAt } = {}) {
  analysis ??= await readAnalysis();
  commit ??= execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  generatedAt ??= new Date().toISOString();
  const sourceIds = new Set();
  const changedSources = new Set(changedCodePaths(analysis.codeHashes, await fingerprintCode()));
  const dirtySourcePaths = uncommittedCodePaths();
  const sources = [];
  for (const source of analysis.sources) {
    assertEvidencePath(source.path);
    if (sourceIds.has(source.id)) {
      throw new Error(`Duplicate source ID: ${source.id}`);
    }
    sourceIds.add(source.id);
    const text = await readFile(join(REPO_ROOT, source.path), 'utf8');
    if (digest(text) !== analysis.sourceHashes[source.path]) {
      changedSources.add(source.path);
    }
    sources.push(sourceExcerpt(text, source));
  }
  for (const catalog of ['features', 'concepts', 'usecases', 'limits']) {
    for (const item of analysis[catalog]) {
      for (const ref of item.refs) {
        if (!sourceIds.has(ref)) {
          throw new Error(`${item.id}: unknown source reference ${ref}`);
        }
      }
    }
  }
  const specFiles = await workflowSources();
  const templates = BUILTIN_TEMPLATES.map((template) => {
    const spec = WorkflowSpecSchema.parse(template.spec);
    const provider = template.workspaceProvider ?? 'git_repo';
    const source = specFiles.find((file) => file.text.includes(`name: '${template.name}'`))?.path;
    if (!source) {
      throw new Error(`No source declaration for built-in template ${template.name}`);
    }
    let category = 'Engineering';
    if (provider === 'document') {
      category = template.name.includes('prd') ? 'Product' : 'Content';
    } else if (provider === 'record') {
      category = 'Support';
    } else if (provider === 'issue_tracker' || template.name.includes('prd')) {
      category = 'Product';
    } else if (provider === 'api_only') {
      category = 'Operations';
    }
    return {
      ...template,
      category,
      edges: Object.fromEntries(
        Object.entries(spec.nodes).map(([id, node]) => [id, nodeEdges(node)])
      ),
      source,
      spec,
      valid: true,
      workspaceProvider: provider,
    };
  });
  const routeFiles = {};
  for (const entry of await readdir(join(REPO_ROOT, 'packages/gateway/src/routes'))) {
    if (entry.endsWith('.ts') && !entry.includes('.test.')) {
      routeFiles[entry.slice(0, -3)] = await readFile(
        join(REPO_ROOT, 'packages/gateway/src/routes', entry),
        'utf8'
      );
    }
  }
  const packages = [];
  for (const entry of await readdir(join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const path = `packages/${entry.name}/package.json`;
      const pkg = JSON.parse(await readFile(join(REPO_ROOT, path), 'utf8'));
      packages.push({ dependencies: pkg.dependencies ?? {}, name: pkg.name, path });
    }
  }
  return {
    agents: parseAgents(await readFile(join(REPO_ROOT, SEED), 'utf8')),
    concepts: analysis.concepts,
    features: analysis.features,
    limits: analysis.limits,
    meta: {
      changedSources: [...changedSources].sort(),
      commit,
      dirtySourcePaths,
      generatedAt,
      homeUrl: siteUrl(''),
      method:
        'Code-derived inventories and anchored evidence from this checkout; human-reviewed narrative ' +
        'is identified separately. No documentation is used as capability evidence. ' +
        'No platform services or external integrations are executed by this build.',
      repoUrl: REPO_URL,
      reviewedCommit: analysis.reviewedCommit,
      url: siteUrl(PLATFORM_EXPLORER.slug),
    },
    models: parseModels(await readFile(join(REPO_ROOT, SCHEMA), 'utf8'), analysis),
    nodeTypes: NodeSchema.options.map((option) => option.shape.type.value),
    packages,
    routes: parseRouteFamilies(
      await readFile(join(REPO_ROOT, 'packages/gateway/src/index.ts'), 'utf8'),
      routeFiles
    ),
    settings: Object.entries(SETTING_DEFINITIONS).map(
      ([key, { schema: _schema, ...definition }]) => ({
        ...definition,
        key,
      })
    ),
    sources,
    steps: listAllSteps(),
    templates,
    usecases: analysis.usecases,
  };
}

export async function writePlatformExplorer() {
  const data = await buildExplorerData();
  const template = await readFile(join(EXPLORER_ROOT, 'platform-explorer.html'), 'utf8');
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, renderExplorer(template, data), 'utf8');
  console.log(
    `Generated platform explorer: ${data.models.length} models, ${data.templates.length} templates`
  );
  if (data.meta.changedSources.length > 0) {
    console.warn(
      `Explorer narrative needs review (${data.meta.changedSources.length} code files changed). ` +
        'Use .claude/skills/platform-explorer/SKILL.md; the published explorer displays this warning.'
    );
  }
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writePlatformExplorer();
}
