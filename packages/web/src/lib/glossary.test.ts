import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractToc } from '@auto-swe/shared/lib/docToc';
import { describe, expect, it } from 'vitest';
import { GLOSSARY, type GlossaryTerm, glossaryEntry } from './glossary';

const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs');

const TERMS = Object.keys(GLOSSARY) as GlossaryTerm[];

describe('GLOSSARY', () => {
  it('covers the vocabulary the product leans on', () => {
    for (const term of [
      'request',
      'run',
      'agentRun',
      'epic',
      'ticket',
      'workflowTemplate',
      'version',
      'node',
      'gate',
      'approval',
      'autonomyPolicy',
      'riskClass',
      'agent',
      'skill',
      'tool',
      'scopeCascade',
      'connection',
      'bundle',
      'eval',
      'lesson',
      'workspace',
      'budgetTier',
      'trace',
      'scannerPattern',
      'canary',
    ] as GlossaryTerm[]) {
      expect(TERMS).toContain(term);
    }
  });

  it.each(TERMS)('%s has a label and a definition', (term) => {
    const entry = glossaryEntry(term);
    expect(entry.label.trim()).not.toBe('');
    expect(entry.definition.trim()).not.toBe('');
  });

  it('describes a ticket as a label, not an auto-swe object', () => {
    expect(GLOSSARY.ticket.definition).toMatch(/not an auto-swe object/);
  });

  it.each(TERMS.filter((term) => 'doc' in GLOSSARY[term]))(
    '%s points at a doc and heading that exist',
    (term) => {
      const { doc } = glossaryEntry(term);
      expect(doc).toBeDefined();
      const file = path.join(DOCS_DIR, `${doc?.slug}.md`);
      expect(existsSync(file), `${doc?.slug}.md`).toBe(true);
      if (doc?.anchor) {
        const ids = extractToc(readFileSync(file, 'utf8')).map((entry) => entry.id);
        expect(ids, `#${doc.anchor} in ${doc.slug}.md`).toContain(doc.anchor);
      }
    }
  );
});
