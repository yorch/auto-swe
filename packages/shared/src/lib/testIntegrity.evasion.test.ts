/**
 * Evasions of the analyser's comment and block handling that a second adversarial review found,
 * each carried out on a diff of the shape `git diff-tree -p -U1 --text` produces: several hunks
 * with a line of context around the changes, which is what lets the analyser tell a block comment
 * added whole from one that only wraps code the diff does not show.
 */
import { describe, expect, it } from 'vitest';
import { analyseTestIntegrity, type TestIntegrityKind } from './testIntegrity.js';

interface Hunk {
  /** First line of the hunk in the old and new file. */
  at: number;
  /** Lines prefixed ' ' (context), '-' (removed) or '+' (added). */
  lines: string[];
}

function hunks(path: string, parts: Hunk[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...parts.flatMap((h) => {
      const oldCount = h.lines.filter((l) => l[0] !== '+').length;
      const newCount = h.lines.filter((l) => l[0] !== '-').length;
      return [`@@ -${h.at},${oldCount} +${h.at},${newCount} @@`, ...h.lines];
    }),
    '',
  ].join('\n');
}

const kinds = (diff: string): TestIntegrityKind[] =>
  analyseTestIntegrity(diff).findings.map((f) => f.kind);

const TS = 'src/a.test.ts';

describe('block comment state does not leak across hunks', () => {
  it('editing a doc-comment opener does not blank a later deleted assertion', () => {
    const diff = hunks(TS, [
      { at: 1, lines: ['-/** old doc', '+/** new doc'] },
      {
        at: 20,
        lines: [
          " it('adds', () => {",
          '-  expect(add(1, 2)).toBe(3);',
          '-  expect(add(-1, -2)).toBe(-3);',
          ' });',
        ],
      },
    ]);
    expect(kinds(diff)).toContain('assertions_reduced');
  });

  it('editing a doc-comment opener is not itself a commented-out test', () => {
    const diff = hunks(TS, [{ at: 1, lines: ['-/** old doc', '+/** new doc', ' * body'] }]);
    expect(kinds(diff)).toEqual([]);
  });
});

describe('a test commented out by added delimiters', () => {
  const BODY = "it('adds', () => {";
  it('block comment opener and closer in two hunks is flagged', () => {
    const diff = hunks(TS, [
      { at: 5, lines: [' import x;', '+/*', ` ${BODY}`] },
      { at: 9, lines: [' });', '+*/', ' end'] },
    ]);
    expect(analyseTestIntegrity(diff).findings).toEqual([
      expect.objectContaining({ kind: 'test_commented_out', line: 6, severity: 'high' }),
    ]);
  });

  it('wrapping a body short enough to share a hunk is flagged too', () => {
    const diff = hunks(TS, [
      {
        at: 5,
        lines: [' import x;', '+/*', ` ${BODY}`, '   expect(1).toBe(1);', ' });', '+*/', ' end'],
      },
    ]);
    expect(kinds(diff)).toEqual(['test_commented_out']);
  });

  it('a block comment added whole is not flagged', () => {
    const diff = hunks(TS, [
      { at: 5, lines: [' import x;', '+/**', '+ * explains the next case', '+ */', ` ${BODY}`] },
    ]);
    expect(kinds(diff)).toEqual([]);
  });

  it('a one-line block comment is not flagged', () => {
    const diff = hunks(TS, [{ at: 5, lines: [' a;', '+/* note */ const x = 1;', ' b;'] }]);
    expect(kinds(diff)).toEqual([]);
  });

  it('a python docstring delimiter pair around unchanged code is flagged', () => {
    const diff = hunks('tests/test_a.py', [
      { at: 3, lines: [' import pytest', '+"""', ' def test_adds():'] },
      { at: 8, lines: ['     assert add(1, 2) == 3', '+"""', ' x = 1'] },
    ]);
    expect(kinds(diff)).toEqual(['test_commented_out']);
  });

  it('a python docstring added whole is not flagged', () => {
    const diff = hunks('tests/test_a.py', [
      {
        at: 3,
        lines: [
          ' def test_adds():',
          '+    """',
          '+    What it checks.',
          '+    """',
          '     assert add(1, 2) == 3',
        ],
      },
    ]);
    expect(kinds(diff)).toEqual([]);
  });

  it('ruby =begin / =end around unchanged code is flagged', () => {
    const diff = hunks('spec/a_spec.rb', [
      { at: 3, lines: [' require "x"', '+=begin', ' it "adds" do'] },
      { at: 9, lines: ['   end', '+=end', ' z'] },
    ]);
    expect(kinds(diff)).toEqual(['test_commented_out']);
  });

  it('commenting each line with // or # still reads as a removal', () => {
    const diff = hunks(TS, [
      {
        at: 5,
        lines: [
          `-${BODY}`,
          '-  expect(add(1, 2)).toBe(3);',
          '-});',
          `+// ${BODY}`,
          '+//   expect(add(1, 2)).toBe(3);',
          '+// });',
        ],
      },
    ]);
    expect(kinds(diff)).toEqual(
      expect.arrayContaining(['test_case_removed', 'assertions_reduced'])
    );
  });
});

describe('comment detection does not hide code that runs', () => {
  const swap = (path: string, added: string) =>
    hunks(path, [{ at: 4, lines: [' a;', '-  prepare();', `+${added}`, ' b;'] }]);

  it('a regex literal ending in an escaped slash is not a // comment', () => {
    expect(kinds(swap(TS, "const re = /a\\//; describe.skip('m', () => {});"))).toContain(
      'skip_marker_added'
    );
  });

  it('a # in TypeScript starts no comment', () => {
    expect(kinds(swap(TS, "const re = /#/; describe.skip('m', () => {});"))).toContain(
      'skip_marker_added'
    );
    expect(kinds(swap(TS, "this.#ready = true; it.skip('m', () => {});"))).toContain(
      'skip_marker_added'
    );
  });

  it('a # at the start of a line is still a comment in Python', () => {
    const diff = hunks('tests/test_a.py', [
      { at: 4, lines: [' a', '-    prepare()', '+    # pytest.mark.skip', ' b'] },
    ]);
    expect(kinds(diff)).toEqual([]);
  });

  it.each([
    ['a lone CR', '\r'],
    ['U+2028', ' '],
    ['U+2029', ' '],
  ])('%s ends a // comment, so the statement after it is read', (_name, terminator) => {
    expect(kinds(swap(TS, `// note${terminator}it.skip('adds', () => {});`))).toContain(
      'skip_marker_added'
    );
  });

  it('a CRLF file does not gain empty lines or lose its tests', () => {
    const diff = hunks(TS, [
      { at: 4, lines: [' a;\r', "-it('adds', () => {\r", "+it('adds', () => {\r", ' b;\r'] },
    ]);
    expect(kinds(diff)).toEqual([]);
  });

  it('a trailing comment cannot stand in for a removed assertion', () => {
    const diff = hunks(TS, [
      {
        at: 4,
        lines: [
          ' a;',
          '-  expect(add(1, 2)).toBe(3);',
          '+  void 0; // expect(add(1, 2)).toBe(3);',
          ' b;',
        ],
      },
    ]);
    expect(kinds(diff)).toContain('assertions_reduced');
  });

  it('a trailing comment after code is read as code for a skip marker', () => {
    expect(kinds(swap(TS, "x(); /* a */ it.skip('adds', () => {});"))).toContain(
      'skip_marker_added'
    );
  });

  it('a block comment that starts a line still hides what it holds', () => {
    expect(kinds(swap(TS, "/* it.skip('adds', () => {}); */"))).toEqual([]);
  });
});

describe('an early return as the first statement of a test', () => {
  it('is flagged when the diff shows the opener as context', () => {
    const diff = hunks(TS, [
      { at: 4, lines: [" it('adds', () => {", '+  return;', '   expect(add(1, 2)).toBe(3);'] },
    ]);
    expect(analyseTestIntegrity(diff).findings).toEqual([
      expect.objectContaining({ kind: 'early_return_added', line: 5, severity: 'high' }),
    ]);
  });

  it('is flagged in python', () => {
    const diff = hunks('tests/test_a.py', [
      { at: 4, lines: [' def test_adds():', '+    return', '     assert add(1, 2) == 3'] },
    ]);
    expect(kinds(diff)).toEqual(['early_return_added']);
  });

  it('is flagged when it replaces the first line of the body', () => {
    const diff = hunks(TS, [
      {
        at: 4,
        lines: [
          " test('adds', async () => {",
          '-  const r = add(1, 2);',
          '+  return;',
          '   expect(r).toBe(3);',
        ],
      },
    ]);
    expect(kinds(diff)).toContain('early_return_added');
  });

  it('is not flagged inside a helper or a callback', () => {
    const diff = hunks(TS, [
      { at: 4, lines: [' const find = (xs) => {', '+  return;', '   expect(add(1, 2)).toBe(3);'] },
    ]);
    expect(kinds(diff)).toEqual([]);
  });

  it('is not flagged when it is not the first statement', () => {
    const diff = hunks(TS, [{ at: 4, lines: ['   const r = add(1, 2);', '+  return;', ' });'] }]);
    expect(kinds(diff)).toEqual([]);
  });
});
