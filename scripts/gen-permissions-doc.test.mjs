import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { END, matrixDrift, START, withMatrix } from './gen-permissions-doc.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(REPO, 'docs/permissions.md'), 'utf8');

describe('gen-permissions-doc', () => {
  it('finds the committed matrix current', () => {
    expect(matrixDrift(REPO)).toBeNull();
  });

  it('is idempotent', () => {
    const once = withMatrix(doc, REPO);
    expect(withMatrix(once, REPO)).toBe(once);
  });

  it('renders every capability and the constraints between the markers', () => {
    const between = doc.slice(doc.indexOf(START), doc.indexOf(END));
    expect(between).toContain('`org.teams.create`');
    expect(between).toContain('`team.sandbox-policy.manage`');
    expect(between).toContain('### Constraints');
    expect(between).toContain('`notAuthor`');
  });

  it('notices a hand-edited matrix', () => {
    const edited = doc.replace('| governance |', '| operation |');
    expect(edited).not.toBe(doc);
    expect(withMatrix(edited, REPO)).toBe(doc);
  });

  it('needs both markers', () => {
    expect(() => withMatrix('# no markers', REPO)).toThrow(/markers|needs/);
  });
});
