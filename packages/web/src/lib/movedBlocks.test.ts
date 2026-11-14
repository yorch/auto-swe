import { describe, expect, it } from 'vitest';
import { parseFilePatch } from '@/components/approvals/diffParse';
import {
  FUZZY_BUCKET_MAX,
  FUZZY_MAX_COMPARISONS,
  findMovedBlocks,
  findMovedBlocksDetailed,
  MOVED_MIN_RUN,
} from './movedBlocks';

const file = (path: string, ...patchLines: string[]) => ({
  lines: parseFilePatch(patchLines.join('\n')).lines,
  path,
});

/** One hunk with a header whose counts match its lines, so several can share a file. */
const hunkOf = (...lines: string[]) => {
  const del = lines.filter((l) => l.startsWith('-')).length;
  const add = lines.filter((l) => l.startsWith('+')).length;
  const ctx = lines.length - del - add;
  return [`@@ -1,${del + ctx} +1,${add + ctx} @@`, ...lines].join('\n');
};

const BLOCK = ['function total(items) {', '  const sum = items.reduce(add, 0);', '  return sum;'];
const removedBlock = BLOCK.map((l) => `-${l}`);
const addedBlock = BLOCK.map((l) => `+${l}`);

// A block long enough that its lines that did not change are a run by themselves, with the edit in
// the middle so every three-line window of it holds the edit.
const LONG = [
  'function total(items) {',
  '  const sum = items.reduce(add, 0);',
  '  const tax = sum * rate;',
  '  log(sum, tax);',
  '  return sum + tax;',
];
const longRemoved = LONG.map((l) => `-${l}`);
const longEdited = LONG.map((l) => `+${l.replace('* rate;', '* rate2;')}`);
const unchangedOf = (lines: string[]) => lines.filter((_, i) => i !== 2);

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

  describe('with edits', () => {
    const edited = [
      'function total(items) {',
      '  const sum = items.reduce(add, 0);',
      '  return sum + 1;',
    ].map((l) => `+${l}`);

    it('finds a moved block with one line edited, marking the lines that did not change', () => {
      const files = [
        file('a.ts', '@@ -1,5 +0,0 @@', ...longRemoved),
        file('b.ts', '@@ -0,0 +1,5 @@', ...longEdited),
      ];
      expect(movedText(files, 'a.ts')).toEqual(unchangedOf(longRemoved));
      expect(movedText(files, 'b.ts')).toEqual(unchangedOf(longEdited));
    });

    it('does not mark a three-line block with one edit: two identical lines are a coincidence', () => {
      const files = [
        file('a.ts', '@@ -1,3 +0,0 @@', ...removedBlock),
        file('b.ts', '@@ -0,0 +1,3 @@', ...edited),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('does not mark two boilerplate lines around an edit as moved', () => {
      const files = [
        file('a.ts', '@@ -1,3 +0,0 @@', '-if (!user) {', '-  return res.status(404).send();', '-}'),
        file(
          'b.ts',
          '@@ -0,0 +1,3 @@',
          '+if (!users) {',
          '+  return res.status(404).send();',
          '+}'
        ),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('does not find a block that was heavily rewritten', () => {
      const rewritten = [
        'export const compute = (list) => {',
        '  let acc = 0; for (const x of list) acc += x;',
        '  return acc;',
      ].map((l) => `+${l}`);
      const files = [
        file('a.ts', '@@ -1,3 +0,0 @@', ...removedBlock),
        file('b.ts', '@@ -0,0 +1,3 @@', ...rewritten),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('does not find a block where only one line is shared', () => {
      const files = [
        file('a.ts', '@@ -1,3 +0,0 @@', ...removedBlock),
        file(
          'b.ts',
          '@@ -0,0 +1,3 @@',
          `+${BLOCK[0]}`,
          '+  console.log("something else entirely");',
          '+  throw new Error("nope");'
        ),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('does not match unrelated blocks with similar-looking boilerplate', () => {
      const files = [
        file(
          'a.ts',
          '@@ -1,3 +0,0 @@',
          '-const alpha = createThing(alphaOptions);',
          '-alpha.configure(alphaSettings);',
          '-export default alpha;'
        ),
        file(
          'b.ts',
          '@@ -0,0 +1,3 @@',
          '+const beta = createThing(betaOptions);',
          '+beta.configure(betaSettings);',
          '+export default beta;'
        ),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('marks only the matched blocks, not the lines around them', () => {
      const files = [
        file(
          'a.ts',
          '@@ -1,7 +0,0 @@',
          '-unrelated first line',
          ...longRemoved,
          '-unrelated last line'
        ),
        file('b.ts', '@@ -0,0 +1,6 @@', '+something else here', ...longEdited),
      ];
      expect(movedText(files, 'a.ts')).toEqual(unchangedOf(longRemoved));
      expect(movedText(files, 'b.ts')).toEqual(unchangedOf(longEdited));
    });

    it('marks a longer moved block with an edit in the middle', () => {
      const long = [
        'const first = readFirstValue(input);',
        'const second = readSecondValue(input);',
        'const third = readThirdValue(input);',
        'return combine(first, second, third);',
      ];
      const changed = [long[0], 'const second = readSecondValues(input, true);', long[2], long[3]];
      const files = [
        file('a.ts', '@@ -1,4 +0,0 @@', ...long.map((l) => `-${l}`)),
        file('b.ts', '@@ -0,0 +1,4 @@', ...changed.map((l) => `+${l}`)),
      ];
      // The edited middle line stays an ordinary change.
      expect(movedText(files, 'a.ts')).toHaveLength(3);
      expect(movedText(files, 'b.ts')).toHaveLength(3);
    });

    it('does no comparisons on a large pull request of unrelated code', () => {
      const n = 5000;
      const del = Array.from({ length: n }, (_, i) => `-const removedValue${i} = compute(${i});`);
      const add = Array.from(
        { length: n },
        (_, i) => `+let addedThing${i} = build("${i}", ${i * 7});`
      );
      const files = [
        file('a.ts', `@@ -1,${n} +0,0 @@`, ...del),
        file('b.ts', `@@ -0,0 +1,${n} @@`, ...add),
      ];
      const { comparisons, moved } = findMovedBlocksDetailed(files);
      expect(moved.size).toBe(0);
      // Nothing is shared, so no bucket yields a candidate at all.
      expect(comparisons).toBe(0);
    });

    it('stays under the comparison cap when many windows share the same lines', () => {
      const rep = Array.from({ length: 3000 }, (_, i) => `-shared repeated line number ${i % 5}`);
      const rep2 = rep.map((l) => `+${l.slice(1)} x`);
      const files = [
        file('a.ts', '@@ -1,3000 +0,0 @@', ...rep),
        file('b.ts', '@@ -0,0 +1,3000 @@', ...rep2),
      ];
      expect(findMovedBlocksDetailed(files).comparisons).toBeLessThanOrEqual(FUZZY_MAX_COMPARISONS);
    });
  });

  describe('an edit inside re-indented code', () => {
    it('is not called moved when the condition was inverted', () => {
      const files = [
        file(
          'a.ts',
          '@@ -1,3 +1,6 @@',
          '-if (user.isAdmin) {',
          '-  grantAccess(user);',
          '-  logAccess(user);',
          '+try {',
          '+  if (!user.isAdmin) {',
          '+    grantAccess(user);',
          '+    logAccess(user);',
          '+  }',
          '+} finally {'
        ),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('is not called moved when a constant changed', () => {
      const files = [
        file(
          'a.ts',
          '@@ -1,3 +1,5 @@',
          '-const client = createClient(config);',
          '-client.setTimeout(30000);',
          '-client.connect();',
          '+if (enabled) {',
          '+  const client = createClient(config);',
          '+  client.setTimeout(300);',
          '+  client.connect();',
          '+}'
        ),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('still finds a move with an edit between two hunks of one file, minus the edited line', () => {
      const files = [
        {
          lines: [
            ...parseFilePatch(hunkOf(...longRemoved)).lines,
            ...parseFilePatch(hunkOf(...longEdited)).lines,
          ],
          path: 'a.ts',
        },
      ];
      expect(movedText(files, 'a.ts')).toEqual([
        ...unchangedOf(longRemoved),
        ...unchangedOf(longEdited),
      ]);
    });

    it('does not pair an in-place edit with a similar block in another hunk of the file', () => {
      const body = [
        'const total = items.reduce(add, 0);',
        'const base = computeBase(items, rate);',
        'const tax = computeTax(total, rate);',
        'const fee = computeFee(total, rate);',
        'return total + tax + fee;',
      ];
      // The edit is in the middle, so every three-line window of the block holds it.
      const reindented = body.map((l) => `  ${l}`);
      reindented[2] = '  const tax = computeTax(total, rate2);';
      const copy = [...body];
      copy[2] = 'const tax = computeTax(total, rate3);';
      const files = [
        {
          lines: [
            ...parseFilePatch(
              hunkOf(...body.map((l) => `-${l}`), ...reindented.map((l) => `+${l}`))
            ).lines,
            ...parseFilePatch(hunkOf(...copy.map((l) => `+${l}`))).lines,
          ],
          path: 'a.ts',
        },
      ];
      // Hunk one is an edit in place; the copy in hunk two is new code, not where it went.
      expect(findMovedBlocks(files).size).toBe(0);
    });

    it('marks only the identical lines of a move across files and leaves the edit unmarked', () => {
      const files = [
        file('a.ts', '@@ -1,5 +0,0 @@', ...longRemoved),
        file('b.ts', '@@ -0,0 +1,5 @@', ...longEdited),
      ];
      expect(movedText(files, 'a.ts')).not.toContain('-  const tax = sum * rate;');
      expect(movedText(files, 'b.ts')).not.toContain('+  const tax = sum * rate2;');
      expect(movedText(files, 'a.ts')).toHaveLength(4);
      expect(movedText(files, 'b.ts')).toHaveLength(4);
    });
  });

  describe('similarity cap', () => {
    it('does not treat two long lines that differ only past the cap as the same', () => {
      const prefix = `const allowedOrigin = ${'x'.repeat(190)}`;
      const one = [`${prefix} = 'https://safe.example.com';`, ...BLOCK.slice(1)];
      const two = [`${prefix} = 'https://evil.example.org';`, ...BLOCK.slice(1)];
      expect(one[0]?.length).toBeGreaterThan(210);
      const files = [
        file('a.ts', '@@ -1,3 +0,0 @@', ...one.map((l) => `-${l}`)),
        file('b.ts', '@@ -0,0 +1,3 @@', ...two.map((l) => `+${l}`)),
      ];
      expect(findMovedBlocks(files).size).toBe(0);
    });
  });

  describe('candidate bookkeeping', () => {
    const L = [
      'const result = computeTotal(items, taxRate);',
      'const label = formatLabel(result, locale);',
      'const note = buildNote(label, result);',
      'return publish(note, result, label);',
    ];

    it('lets each line be claimed by at most one match', () => {
      // The removed run pairs with `a`, an edited copy of it. `c` is another edited copy that
      // shares lines `a` already claimed, so it is not paired with them again.
      const R = [...L, 'await audit(note, result);'];
      const a = [R[0], R[1], 'const note = buildNote(label, result, true);', R[3], R[4]];
      const c = [R[1], R[2], 'return publish(note, result, label, true);', R[4], 'await done();'];
      const files = [
        file('r.ts', '@@ -1,5 +0,0 @@', ...R.map((l) => `-${l}`)),
        file('a.ts', '@@ -0,0 +1,5 @@', ...a.map((l) => `+${l}`)),
        file('c.ts', '@@ -0,0 +1,5 @@', ...c.map((l) => `+${l}`)),
      ];
      const moved = findMovedBlocks(files);
      expect(moved.get('a.ts')?.size).toBe(4);
      expect(moved.get('c.ts')).toBeUndefined();
    });

    it('finds no candidates through a line shared by more windows than the bucket allows', () => {
      const shared = 'const sharedBoilerplate = createSharedBoilerplate(options);';
      const blocks = (n: number) => {
        const files = [];
        for (let i = 0; i < n; i++) {
          files.push(
            file(
              `r${i}.ts`,
              '@@ -1,3 +0,0 @@',
              `-${shared}`,
              `-a = ${i};`,
              `-const edited = compute(${i});`
            ),
            file(
              `a${i}.ts`,
              '@@ -0,0 +1,3 @@',
              `+${shared}`,
              `+a = ${i};`,
              `+const edited = compute(${i}, 1);`
            )
          );
        }
        return findMovedBlocksDetailed(files);
      };
      // At the bucket size the pairs are compared (each block has one edit among three lines, so
      // none is marked: two identical lines are not a run); one more and the line is boilerplate.
      expect(blocks(FUZZY_BUCKET_MAX).comparisons).toBe(FUZZY_BUCKET_MAX * FUZZY_BUCKET_MAX);
      const over = blocks(FUZZY_BUCKET_MAX + 1);
      expect(over.comparisons).toBe(0);
      expect(over.moved.size).toBe(0);
    });

    it('stops comparing at the cap when the candidates really exceed it', () => {
      const groups = Math.ceil(FUZZY_MAX_COMPARISONS / (FUZZY_BUCKET_MAX * FUZZY_BUCKET_MAX)) + 5;
      const del: string[] = [];
      const add: string[] = [];
      for (let g = 0; g < groups; g++) {
        for (let j = 0; j < FUZZY_BUCKET_MAX; j++) {
          del.push(
            `-const groupKeyLine${g} = shared(${g});`,
            `-removed unique ${g} ${j} first`,
            `-removed unique ${g} ${j} second`,
            ' ctx'
          );
          add.push(
            `+const groupKeyLine${g} = shared(${g});`,
            `+added different ${g} ${j} first`,
            `+added different ${g} ${j} second`,
            ' ctx'
          );
        }
      }
      const files = [file('a.ts', hunkOf(...del)), file('b.ts', hunkOf(...add))];
      expect(findMovedBlocksDetailed(files).comparisons).toBe(FUZZY_MAX_COMPARISONS);
    });
  });
});
