import { describe, expect, it } from 'vitest';
import { resolveRepoPath, rewriteLink, rewriteMarkdownLinks } from './docLinks.mjs';

const REPO = 'https://github.com/yorch/auto-swe';

/**
 * A cut-down route map. The real one is derived from the manifest; these are the
 * shapes that matter — a doc, the docs index, and a page published from outside
 * `docs/`.
 */
const routes = new Map([
  ['docs/README.md', '/auto-swe/docs/'],
  ['docs/agents.md', '/auto-swe/docs/agents/'],
  ['docs/architecture.md', '/auto-swe/docs/architecture/'],
  ['README.md', '/auto-swe/introduction/'],
  ['packages/cli/README.md', '/auto-swe/reference/cli/'],
]);

const from = (sourcePath) => ({ ref: 'main', repoUrl: REPO, routes, sourcePath });

describe('resolveRepoPath', () => {
  it('resolves a sibling reference against the source file directory', () => {
    expect(resolveRepoPath('docs/agents.md', './architecture.md')).toBe('docs/architecture.md');
    expect(resolveRepoPath('docs/agents.md', 'architecture.md')).toBe('docs/architecture.md');
  });

  it('walks out of the directory for a parent reference', () => {
    expect(resolveRepoPath('docs/agents.md', '../AGENTS.md')).toBe('AGENTS.md');
    expect(resolveRepoPath('packages/cli/README.md', '../../docs/evals.md')).toBe('docs/evals.md');
  });

  it('descends into a subdirectory', () => {
    expect(resolveRepoPath('docs/README.md', './history/PLAN.md')).toBe('docs/history/PLAN.md');
  });

  it('keeps a trailing slash off the resolved path', () => {
    expect(resolveRepoPath('docs/README.md', './history/')).toBe('docs/history');
  });

  // `..` past the root is already a broken link in the checkout. Collapsing to
  // the root at least produces a URL that resolves to something.
  it('collapses a parent reference that escapes the repository root', () => {
    expect(resolveRepoPath('README.md', '../../elsewhere.md')).toBe('elsewhere.md');
  });
});

describe('rewriteLink', () => {
  it('rewrites a cross-reference between two published docs', () => {
    expect(rewriteLink('./architecture.md', from('docs/agents.md'))).toBe(
      '/auto-swe/docs/architecture/'
    );
  });

  it('carries the fragment through to the site URL', () => {
    expect(rewriteLink('./architecture.md#4-workflow-engine', from('docs/agents.md'))).toBe(
      '/auto-swe/docs/architecture/#4-workflow-engine'
    );
  });

  it('sends the docs index to the section root, not to a page named README', () => {
    expect(rewriteLink('./README.md', from('docs/agents.md'))).toBe('/auto-swe/docs/');
  });

  it('resolves a link that leaves docs/ for a page published from elsewhere', () => {
    expect(rewriteLink('../packages/cli/README.md', from('docs/README.md'))).toBe(
      '/auto-swe/reference/cli/'
    );
    expect(rewriteLink('../../docs/agents.md', from('packages/cli/README.md'))).toBe(
      '/auto-swe/docs/agents/'
    );
  });

  // The whole point of the GitHub fallback: contributor material and frozen
  // docs stay reachable without being published as current product behaviour.
  it('falls back to GitHub for a file the site does not publish', () => {
    expect(rewriteLink('../AGENTS.md', from('docs/agents.md'))).toBe(`${REPO}/blob/main/AGENTS.md`);
    expect(rewriteLink('./history/PLAN.md', from('docs/README.md'))).toBe(
      `${REPO}/blob/main/docs/history/PLAN.md`
    );
  });

  it('keeps the fragment on a GitHub fallback', () => {
    expect(rewriteLink('../AGENTS.md#runtime-security-scanners', from('docs/agents.md'))).toBe(
      `${REPO}/blob/main/AGENTS.md#runtime-security-scanners`
    );
  });

  it('uses a tree URL for a directory, which GitHub browses differently', () => {
    expect(rewriteLink('./history/', from('docs/README.md'))).toBe(
      `${REPO}/tree/main/docs/history`
    );
  });

  it.each([
    ['https://example.com/x', 'an absolute URL'],
    ['//example.com/x', 'a protocol-relative URL'],
    ['mailto:someone@example.com', 'a mailto link'],
    ['#a-heading-on-this-page', 'a bare fragment'],
    ['', 'an empty href'],
  ])('leaves %s alone (%s)', (href) => {
    expect(rewriteLink(href, from('docs/agents.md'))).toBe(href);
  });
});

describe('rewriteMarkdownLinks', () => {
  it('rewrites inline links and leaves the link text untouched', () => {
    const out = rewriteMarkdownLinks('See [the agent layer](./agents.md) for more.', {
      ...from('docs/architecture.md'),
    });
    expect(out).toBe('See [the agent layer](/auto-swe/docs/agents/) for more.');
  });

  it('preserves a link title', () => {
    const out = rewriteMarkdownLinks('[a](./agents.md "Agents")', {
      ...from('docs/architecture.md'),
    });
    expect(out).toBe('[a](/auto-swe/docs/agents/ "Agents")');
  });

  it('rewrites a reference definition', () => {
    const out = rewriteMarkdownLinks('[ref]: ./agents.md\n', { ...from('docs/architecture.md') });
    expect(out).toBe('[ref]: /auto-swe/docs/agents/\n');
  });

  it('unwraps an angle-bracketed href', () => {
    const out = rewriteMarkdownLinks('[a](<./agents.md>)', { ...from('docs/architecture.md') });
    expect(out).toBe('[a](/auto-swe/docs/agents/)');
  });

  // A link-shaped string inside a fence is sample text. Rewriting it would
  // silently corrupt an example that the reader is meant to copy.
  it('does not touch a link inside a fenced code block', () => {
    const source = ['Before [x](./agents.md)', '', '```md', '[y](./agents.md)', '```', ''].join(
      '\n'
    );
    const out = rewriteMarkdownLinks(source, { ...from('docs/architecture.md') });
    expect(out).toContain('Before [x](/auto-swe/docs/agents/)');
    expect(out).toContain('[y](./agents.md)');
  });

  // A shorter fence nested inside a longer one must not close its parent: a
  // naive in-fence toggle resumes rewriting halfway through the example.
  it('does not let a nested fence close its parent early', () => {
    const source = ['````md', '```mermaid', '[y](./agents.md)', '```', '````', ''].join('\n');
    const out = rewriteMarkdownLinks(source, { ...from('docs/architecture.md') });
    expect(out).toBe(source);
  });

  it('leaves a document with no relative links byte-identical', () => {
    const source = '# Title\n\nSee [elsewhere](https://example.com) and `./agents.md`.\n';
    expect(rewriteMarkdownLinks(source, { ...from('docs/architecture.md') })).toBe(source);
  });
});
