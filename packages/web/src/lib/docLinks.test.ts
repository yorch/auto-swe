import { describe, expect, it } from 'vitest';
import { resolveDocLink } from './docLinks.js';

/** The real top-level docs, as `listDocs()` would report them. */
const SERVED = new Set([
  'README',
  'agents',
  'architecture',
  'channel-assistant',
  'deployment',
  'evals',
  'figma-integration',
  'github-app-setup',
  'hitl-workflows',
  'model-configuration',
  'nl-workflow-authoring',
  'oauth-setup',
  'product-overview',
  'slack-app-setup',
]);

const resolve = (href: string) => resolveDocLink(href, SERVED);

describe('resolveDocLink', () => {
  describe('cross-doc links — the 404 class this exists to fix', () => {
    it('rewrites a sibling doc to its page', () => {
      // Rendered raw this became /docs/agents.md, which the route rejects.
      expect(resolve('./agents.md')).toEqual({ href: '/docs/agents', kind: 'doc' });
    });

    it('rewrites without the leading ./', () => {
      expect(resolve('architecture.md')).toEqual({ href: '/docs/architecture', kind: 'doc' });
    });

    it('carries the anchor across', () => {
      expect(resolve('./agents.md#11-limitations')).toEqual({
        href: '/docs/agents#11-limitations',
        kind: 'doc',
      });
    });

    it('handles an anchor containing further hashes', () => {
      expect(resolve('./evals.md#a#b')).toEqual({ href: '/docs/evals#a#b', kind: 'doc' });
    });

    it('is case-insensitive about the extension', () => {
      expect(resolve('./README.MD')).toEqual({ href: '/docs/README', kind: 'doc' });
    });
  });

  describe('links that cannot be served', () => {
    it('refuses to link out of the docs tree', () => {
      // `../AGENTS.md` would render as /AGENTS.md — a 404 at the app root.
      expect(resolve('../AGENTS.md')).toMatchObject({ kind: 'unserved' });
      expect(resolve('../README.md')).toMatchObject({ kind: 'unserved' });
    });

    it('refuses frozen history docs, which are deliberately unpublished', () => {
      expect(resolve('./history/evals-rfc.md')).toMatchObject({ kind: 'unserved' });
      expect(resolve('history/platform-pivot.md')).toMatchObject({ kind: 'unserved' });
    });

    it('refuses other subdirectories', () => {
      expect(resolve('./redesign/README.md')).toMatchObject({ kind: 'unserved' });
    });

    it('refuses non-Markdown siblings', () => {
      expect(resolve('./slack-app-manifest.json')).toMatchObject({ kind: 'unserved' });
    });

    it('refuses a doc that does not exist', () => {
      expect(resolve('./no-such-doc.md')).toMatchObject({ kind: 'unserved' });
    });

    it('treats a path that climbs and returns as outside the tree', () => {
      // `../docs/agents.md` happens to resolve, but only from a checkout — the
      // served surface is flat, so refuse rather than guess.
      expect(resolve('../docs/agents.md')).toMatchObject({ kind: 'unserved' });
    });
  });

  describe('links that must be left alone', () => {
    it('passes through absolute URLs', () => {
      for (const href of [
        'https://api.slack.com/apps',
        'http://localhost:8080',
        'mailto:security@example.com',
        '//cdn.example.com/x.md',
      ]) {
        expect(resolve(href)).toEqual({ href, kind: 'href' });
      }
    });

    it('passes through bare anchors', () => {
      expect(resolve('#7-non-goals--out-of-scope')).toEqual({
        href: '#7-non-goals--out-of-scope',
        kind: 'href',
      });
    });

    it('passes through dashboard routes', () => {
      // Docs cite in-app paths constantly; these already resolve.
      expect(resolve('/admin/model-config')).toEqual({
        href: '/admin/model-config',
        kind: 'href',
      });
    });

    it('passes through an empty href rather than throwing', () => {
      expect(resolve('')).toEqual({ href: '', kind: 'href' });
    });
  });
});
