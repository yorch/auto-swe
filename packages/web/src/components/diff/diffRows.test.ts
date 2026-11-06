import { describe, expect, it } from 'vitest';
import { parseFilePatch } from '../approvals/diffParse';
import { type DiffRow, pairSideBySide } from './diffRows';

const rowsOf = (patch: string): DiffRow[] => pairSideBySide(parseFilePatch(patch).lines);

/** `[left text, right text]` for a pair, `'full'` for a spanning row. */
const shape = (rows: DiffRow[]) =>
  rows.map((row) =>
    row.type === 'full' ? 'full' : [row.left?.text ?? null, row.right?.text ?? null]
  );

describe('pairSideBySide', () => {
  it('puts an unchanged line on both sides with its own number on each', () => {
    const [header, row] = rowsOf(['@@ -10,1 +20,1 @@', ' keep'].join('\n'));
    expect(header?.type).toBe('full');
    expect(row).toEqual({
      left: { index: 1, kind: 'ctx', no: 10, text: 'keep' },
      right: { index: 1, kind: 'ctx', no: 20, text: 'keep' },
      type: 'pair',
    });
  });

  it('sets the old and new version of an edited line across from each other', () => {
    expect(shape(rowsOf(['@@ -1,2 +1,2 @@', ' a', '-old', '+new'].join('\n')))).toEqual([
      'full',
      ['a', 'a'],
      ['old', 'new'],
    ]);
  });

  it('zips a run of removals with the run of additions after it, one to one', () => {
    expect(
      shape(rowsOf(['@@ -1,3 +1,3 @@', '-r1', '-r2', '-r3', '+a1', '+a2', '+a3'].join('\n')))
    ).toEqual(['full', ['r1', 'a1'], ['r2', 'a2'], ['r3', 'a3']]);
  });

  it('leaves the shorter side empty for the rest of a longer run', () => {
    expect(shape(rowsOf(['@@ -1,3 +1,1 @@', '-r1', '-r2', '-r3', '+a1'].join('\n')))).toEqual([
      'full',
      ['r1', 'a1'],
      ['r2', null],
      ['r3', null],
    ]);
    expect(shape(rowsOf(['@@ -1,1 +1,3 @@', '-r1', '+a1', '+a2', '+a3'].join('\n')))).toEqual([
      'full',
      ['r1', 'a1'],
      [null, 'a2'],
      [null, 'a3'],
    ]);
  });

  it('shows an addition with nothing removed before it, and a removal with nothing added, alone', () => {
    expect(shape(rowsOf(['@@ -1,1 +1,2 @@', ' a', '+b'].join('\n')))).toEqual([
      'full',
      ['a', 'a'],
      [null, 'b'],
    ]);
    expect(shape(rowsOf(['@@ -1,2 +1,1 @@', ' a', '-b'].join('\n')))).toEqual([
      'full',
      ['a', 'a'],
      ['b', null],
    ]);
  });

  it('starts a new edit when a removal follows additions', () => {
    expect(shape(rowsOf(['@@ -1,2 +1,2 @@', '-r1', '+a1', '-r2', '+a2'].join('\n')))).toEqual([
      'full',
      ['r1', 'a1'],
      ['r2', 'a2'],
    ]);
  });

  it('does not pair across an unchanged line', () => {
    expect(shape(rowsOf(['@@ -1,3 +1,3 @@', '-r1', ' keep', '+a1'].join('\n')))).toEqual([
      'full',
      ['r1', null],
      ['keep', 'keep'],
      [null, 'a1'],
    ]);
  });

  it('numbers each side from its own hunk counter', () => {
    const rows = rowsOf(['@@ -5,2 +9,3 @@', ' keep', '-gone', '+one', '+two'].join('\n'));
    const pairs = rows.filter((r) => r.type === 'pair');
    expect(
      pairs.map((r) => (r.type === 'pair' ? [r.left?.no ?? null, r.right?.no ?? null] : null))
    ).toEqual([
      [5, 9],
      [6, 10],
      [null, 11],
    ]);
  });

  it('gives each hunk header and each marker line a spanning row of its own', () => {
    const rows = rowsOf(
      ['@@ -1,1 +1,1 @@', '-a', '+b', '\\ No newline at end of file', '@@ -9,1 +9,1 @@', ' z'].join(
        '\n'
      )
    );
    expect(rows.map((r) => r.type)).toEqual(['full', 'pair', 'full', 'full', 'pair']);
  });

  it('keeps a line that begins with a marker character after the marker is dropped', () => {
    expect(shape(rowsOf(['@@ -1,1 +1,1 @@', '-- a', '+++ b'].join('\n')))).toEqual([
      'full',
      ['- a', '++ b'],
    ]);
  });

  it('draws every line exactly once, whatever the patch looks like', () => {
    const patch = ['@@ -1,6 +1,6 @@', ' a', '-b', '-c', '+B', ' d', '+e', '-f', '+g', '-h'].join(
      '\n'
    );
    const lines = parseFilePatch(patch).lines;
    const rows = pairSideBySide(lines);
    const drawn = rows.reduce((count, row) => {
      if (row.type === 'full') {
        return count + 1;
      }
      // An unchanged pair is one line shown twice.
      if (row.left?.kind === 'ctx') {
        return count + 1;
      }
      return count + (row.left ? 1 : 0) + (row.right ? 1 : 0);
    }, 0);
    expect(drawn).toBe(lines.length);
  });

  it('records which line each cell came from', () => {
    // 0 is the hunk header, 1 the unchanged line, 2 the removed one, 3 and 4 the added ones.
    const rows = rowsOf(['@@ -1,2 +1,3 @@', ' keep', '-gone', '+one', '+two'].join('\n'));
    const pairs = rows.filter((r) => r.type === 'pair');
    expect(
      pairs.map((r) => (r.type === 'pair' ? [r.left?.index ?? null, r.right?.index ?? null] : null))
    ).toEqual([
      [1, 1],
      [2, 3],
      [null, 4],
    ]);
  });

  it('answers no rows for no lines', () => {
    expect(pairSideBySide([])).toEqual([]);
  });
});
