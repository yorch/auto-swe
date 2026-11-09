import { describe, expect, it } from 'vitest';
import { parseFilePatch } from '@/components/approvals/diffParse';
import { findMovedBlocks, MOVED_MIN_RUN } from './movedBlocks';

const file = (path: string, ...patchLines: string[]) => ({
  lines: parseFilePatch(patchLines.join('\n')).lines,
  path,
});

const BLOCK = ['function total(items) {', '  const sum = items.reduce(add, 0);', '  return sum;'];
const removedBlock = BLOCK.map((l) => `-${l}`);
const addedBlock = BLOCK.map((l) => `+${l}`);

/** The moved lines of a file as the text of its lines. */
const movedText = (files: ReturnType<typeof file>[], path: string) => {
  const moved = findMovedBlocks(files).get(path) ?? new Set<number>();
  const lines = files.find((f) => f.path === path)?.lines ?? [];
  return [...moved].sort((a, b) => a - b).map((i) => lines[i]?.text);
};

describe('findMovedBlocks', () => {
  it('finds a block removed from one file and added to another', () => {
    const files = [
      file('a.ts', '@@ -1,3 +0,0 @@', ...removedBlock),
      file('b.ts', '@@ -0,0 +1,3 @@', ...addedBlock),
    ];
    expect(movedText(files, 'a.ts')).toEqual(removedBlock);
    expect(movedText(files, 'b.ts')).toEqual(addedBlock);
  });

  it('finds a block moved within one file', () => {
    const files = [
      file('a.ts', '@@ -1,9 +1,9 @@', ...removedBlock, ' keep one', ' keep two', ...addedBlock),
    ];
    expect(movedText(files, 'a.ts')).toEqual([...removedBlock, ...addedBlock]);
  });

  it('ignores indentation and blank lines when matching', () => {
    const files = [
      file('a.ts', '@@ -1,3 +0,0 @@', ...removedBlock),
      file(
        'b.ts',
        '@@ -0,0 +1,4 @@',
        `+    ${BLOCK[0]}`,
        '+',
        `+        ${BLOCK[1]}`,
        `+\t${BLOCK[2]}`
      ),
    ];
    expect(findMovedBlocks(files).get('a.ts')?.size).toBe(3);
    expect(findMovedBlocks(files).get('b.ts')?.size).toBe(3);
  });

  it('finds a block that is only part of a longer run', () => {
    const files = [
      file('a.ts', '@@ -1,5 +0,0 @@', '-first line here', '-second line here', ...removedBlock),
      file('b.ts', '@@ -0,0 +1,3 @@', ...addedBlock),
    ];
    expect(movedText(files, 'b.ts')).toEqual(addedBlock);
    // The removed run is flagged only where it matches, not the two lines before it.
    expect(movedText(files, 'a.ts')).toEqual(removedBlock);
  });

  it('does not call a rewrite a move', () => {
    const files = [
      file('a.ts', '@@ -1,3 +0,0 @@', ...removedBlock),
      file('b.ts', '@@ -0,0 +1,3 @@', '+function sum(list) {', '+  return list.length;', '+}'),
    ];
    expect(findMovedBlocks(files).size).toBe(0);
  });

  it('needs a run of at least the minimum, not a coincidence', () => {
    expect(MOVED_MIN_RUN).toBe(3);
    const two = removedBlock.slice(0, 2);
    const files = [
      file('a.ts', '@@ -1,2 +0,0 @@', ...two),
      file('b.ts', '@@ -0,0 +1,2 @@', ...two.map((l) => `+${l.slice(1)}`)),
    ];
    expect(findMovedBlocks(files).size).toBe(0);
  });

  it('does not match lines that carry nothing, like closing braces', () => {
    const files = [
      file('a.ts', '@@ -1,3 +0,0 @@', '-}', '-});', '-};'),
      file('b.ts', '@@ -0,0 +1,3 @@', '+}', '+});', '+};'),
    ];
    expect(findMovedBlocks(files).size).toBe(0);
  });

  it('does not match a block that was only added, or only removed', () => {
    expect(findMovedBlocks([file('a.ts', '@@ -0,0 +1,3 @@', ...addedBlock)]).size).toBe(0);
    expect(findMovedBlocks([file('a.ts', '@@ -1,3 +0,0 @@', ...removedBlock)]).size).toBe(0);
  });

  it('does not join lines across an unchanged line', () => {
    const files = [
      file('a.ts', '@@ -1,4 +0,0 @@', `-${BLOCK[0]}`, `-${BLOCK[1]}`, ' unchanged', `-${BLOCK[2]}`),
      file('b.ts', '@@ -0,0 +1,3 @@', ...addedBlock),
    ];
    expect(findMovedBlocks(files).size).toBe(0);
  });

  it('answers nothing for no files', () => {
    expect(findMovedBlocks([]).size).toBe(0);
  });

  it('marks the index of each line in its own file, so a caller can find it', () => {
    const files = [
      file('a.ts', '@@ -1,4 +0,0 @@', '-unrelated line', ...removedBlock),
      file('b.ts', '@@ -0,0 +1,3 @@', ...addedBlock),
    ];
    const moved = findMovedBlocks(files).get('a.ts');
    // Index 0 is the hunk header, 1 the unrelated line, 2 to 4 the block.
    expect([...(moved ?? [])].sort()).toEqual([2, 3, 4]);
  });
});
