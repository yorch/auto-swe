import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildDocSearchIndexFromDir } from './docFiles.js';
import {
  buildSearchIndex,
  countMatchingTerms,
  highlight,
  indexDoc,
  MAX_QUERY_CHARS,
  MAX_QUERY_TERMS,
  MAX_RESULTS,
  sameStem,
  searchDocs,
  stemForms,
  tokenize,
  words,
} from './docSearch.js';
import { extractToc } from './docToc.js';

const DOC = `# Agents

Lead paragraph about **agents** and [skills](./skills.md).

## Skills

A skill is a prompt fragment. See [the guide](https://example.com/secret-url).

\`\`\`ts
const hiddenInFence = 'zebracode';
\`\`\`

| Name | Role |
| ---- | ---- |
| implementer | writes code |

### Tools

Tools are executable. Use \`readFile\` to read.

## Skills

Second skills section.
`;

describe('indexDoc', () => {
  const sections = indexDoc(DOC);

  it('anchors every heading section with the id extractToc gives it', () => {
    const toc = extractToc(DOC);
    expect(sections.filter((s) => s.anchor).map((s) => s.anchor)).toEqual(toc.map((t) => t.id));
    expect(sections.map((s) => s.anchor)).toEqual([null, 'skills', 'tools', 'skills-1']);
  });

  it('keeps the lead before the first heading as an unanchored section', () => {
    expect(sections[0]).toMatchObject({ anchor: null, heading: null });
    expect(sections[0]?.text).toBe('Lead paragraph about agents and skills.');
  });

  it('strips code fences, link targets and table syntax', () => {
    const text = sections.map((s) => s.text).join(' ');
    expect(text).not.toContain('zebracode');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('|');
    expect(text).not.toContain('---');
    expect(text).not.toContain('**');
    expect(text).toContain('the guide');
    expect(text).toContain('implementer writes code');
  });

  it('keeps inline code words, which readers search for', () => {
    expect(sections[2]?.text).toBe('Tools are executable. Use readFile to read.');
  });

  it('keeps a section with a table as blocks, so a reader can cut it by rows', () => {
    expect(sections[1]?.blocks).toEqual([
      'A skill is a prompt fragment. See the guide.',
      { header: ['Name', 'Role'], rows: [['implementer', 'writes code']] },
    ]);
    expect(sections[0]?.blocks).toBeUndefined();
    expect(sections[2]).not.toHaveProperty('blocks');
  });

  it('stays in step when a heading is nested in a blockquote', () => {
    const md = '## One\n\ntext\n\n> ## Quoted\n\n## Two\n\nbody\n';
    const toc = extractToc(md);
    const anchors = indexDoc(md).map((s) => s.anchor);
    expect(anchors).toEqual(['one', 'two']);
    expect(toc.map((t) => t.id)).toEqual(['one', 'quoted', 'two']);
  });
});

const INDEX = buildSearchIndex([
  {
    content: '# Agents\n\nIntro.\n\n## Skills\n\nSkills shape reasoning. Budget is unrelated.\n',
    slug: 'agents',
    title: 'Agents',
  },
  {
    content: '# Budgets\n\n## Limits\n\nThe budget caps tokens for a skill-heavy run.\n',
    slug: 'budgets',
    title: 'Budgets',
  },
  {
    content:
      '# Evals\n\n## Scoring\n\nA budget of tokens and a skill appear here.\n\n## Budget\n\nCaps.\n',
    slug: 'evals',
    title: 'Evals',
  },
]);

describe('searchDocs', () => {
  it('ranks title over heading over body', () => {
    const r = searchDocs(INDEX, 'budget');
    // Budgets (title+body), Evals "Budget" heading, then body-only matches
    expect(r.map((x) => `${x.slug}#${x.anchor}`)).toEqual([
      'budgets#limits',
      'evals#budget',
      'agents#skills',
      'evals#scoring',
    ]);
  });

  it('requires every term to match (AND), across title, heading and body', () => {
    const r = searchDocs(INDEX, 'budget skill');
    expect(r.map((x) => `${x.slug}#${x.anchor}`)).toEqual([
      'budgets#limits',
      'agents#skills',
      'evals#scoring',
    ]);
    expect(searchDocs(INDEX, 'budget zebra')).toEqual([]);
  });

  it('is case-insensitive and ignores repeated terms and extra whitespace', () => {
    expect(searchDocs(INDEX, '  BUDGET   budget ')).toEqual(searchDocs(INDEX, 'budget'));
  });

  it('returns nothing for a blank query or no match', () => {
    expect(searchDocs(INDEX, '   ')).toEqual([]);
    expect(searchDocs(INDEX, 'nonexistentterm')).toEqual([]);
  });

  it('bounds the result count', () => {
    const many = buildSearchIndex([
      {
        content: Array.from({ length: 50 }, (_, i) => `## S${i}\n\nneedle ${i}\n`).join('\n'),
        slug: 'many',
        title: 'Many',
      },
    ]);
    expect(searchDocs(many, 'needle')).toHaveLength(MAX_RESULTS);
    expect(searchDocs(many, 'needle', 3)).toHaveLength(3);
  });

  it('returns highlighted segments for title, heading and snippet', () => {
    const [first] = searchDocs(INDEX, 'budget');
    expect(first?.title).toEqual([
      { match: true, text: 'Budget' },
      { match: false, text: 's' },
    ]);
    expect(first?.snippet.some((s) => s.match && s.text.toLowerCase() === 'budget')).toBe(true);
    const lead = searchDocs(INDEX, 'intro')[0];
    expect(lead?.heading).toBeNull();
  });

  it('windows a long section around the first match with ellipses', () => {
    const long = `${'filler word '.repeat(60)}needle ${'trailing word '.repeat(60)}`;
    const idx = buildSearchIndex([{ content: `## A\n\n${long}\n`, slug: 'x', title: 'X' }]);
    const [r] = searchDocs(idx, 'needle');
    const text = r?.snippet.map((s) => s.text).join('') ?? '';
    expect(text.length).toBeLessThan(220);
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(r?.snippet.some((s) => s.match)).toBe(true);
  });
});

describe('highlight', () => {
  it('never produces markup: html in the text stays literal text', () => {
    const segs = highlight('<img src=x onerror=alert(1)> script', ['script']);
    expect(segs.map((s) => s.text).join('')).toBe('<img src=x onerror=alert(1)> script');
    expect(segs.filter((s) => s.match).map((s) => s.text)).toEqual(['script']);
  });

  it('treats regex metacharacters in a term literally', () => {
    expect(highlight('a (b) c', ['(b)'])).toEqual([
      { match: false, text: 'a ' },
      { match: true, text: '(b)' },
      { match: false, text: ' c' },
    ]);
    expect(() => highlight('x', ['[', '*', '\\'])).not.toThrow();
  });

  it('matches case-insensitively but keeps the original casing', () => {
    expect(highlight('Skill skill', ['SKILL']).map((s) => s.text)).toEqual(['Skill', ' ', 'skill']);
  });

  it('returns no segments for empty text and one plain run without terms', () => {
    expect(highlight('', ['a'])).toEqual([]);
    expect(highlight('abc', [])).toEqual([{ match: false, text: 'abc' }]);
  });
});

describe('tokenize', () => {
  it('lowercases, splits on whitespace and de-duplicates', () => {
    expect(tokenize(' Foo  bar FOO ')).toEqual(['foo', 'bar']);
  });

  it('cuts a long query and keeps at most MAX_QUERY_TERMS terms', () => {
    expect(tokenize('a'.repeat(MAX_QUERY_CHARS + 20))).toEqual(['a'.repeat(MAX_QUERY_CHARS)]);
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(tokenize(many)).toHaveLength(MAX_QUERY_TERMS);
  });
});

describe('stem', () => {
  const allSame = (words: string[]) => words.every((a) => words.every((b) => sameStem(a, b)));

  it('joins singular and plural', () => {
    for (const [a, b] of [
      ['skills', 'skill'],
      ['policies', 'policy'],
      ['boxes', 'box'],
      ['branches', 'branch'],
      ['queues', 'queue'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(true);
    }
  });

  it('joins every inflection of approve, create and use', () => {
    expect(allSame(['approve', 'approves', 'approved', 'approving'])).toBe(true);
    expect(allSame(['create', 'creates', 'created', 'creating'])).toBe(true);
    expect(allSame(['use', 'uses', 'used', 'using'])).toBe(true);
    expect(allSame(['rate', 'rates', 'rated', 'rating'])).toBe(true);
  });

  it('does not collapse a bare word onto a different, shorter word', () => {
    for (const [a, b] of [
      ['rate', 'rat'],
      ['base', 'bas'],
      ['here', 'her'],
      ['name', 'nam'],
      ['rates', 'rat'],
      ['names', 'nam'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(false);
      expect(sameStem(b, a), `${b}/${a}`).toBe(false);
    }
  });

  it('does not read seed, feed, being or doing as inflections of a two-letter word', () => {
    for (const [a, b] of [
      ['seed', 'see'],
      ['feed', 'fee'],
      ['being', 'bee'],
      ['doing', 'doe'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(false);
    }
  });

  it('joins -ing and -ed forms of a doubled consonant, but keeps ll, ss and zz', () => {
    expect(sameStem('running', 'run')).toBe(true);
    expect(sameStem('stopped', 'stop')).toBe(true);
    expect(stemForms('skilled')).toContain('skill');
    expect(stemForms('passed')).toContain('pass');
  });

  it('leaves short words and non-words alone', () => {
    for (const w of ['is', 'ids', 'bus', 'was', 'ing', 'ed', 'sed', 'gas']) {
      expect(stemForms(w), w).toEqual([w]);
    }
    for (const w of ['AUTO_SWE_TOKEN', 'v2', 'ciWait-Mode', 'a.b', 'x86s']) {
      expect(stemForms(w), w).toEqual([w.toLowerCase()]);
    }
  });

  it('does not damage words that merely end like a suffix', () => {
    for (const w of ['status', 'access', 'process', 'analysis', 'this', 'bed', 'sing', 'string']) {
      expect(stemForms(w), w).toEqual([w]);
    }
    // `-ing`/`-ed` need a vowel left in the stem.
    expect(stemForms('strengthed')).not.toContain('str');
  });

  it('does not read an -ed or -ing word as an unrelated bare word', () => {
    for (const [a, b] of [
      ['noted', 'not'],
      ['rated', 'rat'],
      ['hoped', 'hop'],
      ['mined', 'min'],
      ['sited', 'sit'],
      ['sitting', 'site'],
      ['planning', 'plane'],
      ['running', 'rune'],
      ['setting', 'sete'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(false);
      expect(sameStem(b, a), `${b}/${a}`).toBe(false);
    }
    expect(stemForms('noted')).toEqual(['note']);
    expect(stemForms('sitting')).toEqual(['sit']);
  });

  it('still joins an -ed or -ing word with its own base', () => {
    for (const [a, b] of [
      ['noted', 'note'],
      ['noting', 'notes'],
      ['hoped', 'hope'],
      ['mined', 'mine'],
      ['sited', 'site'],
      ['sitting', 'sit'],
      ['planned', 'plan'],
      ['planning', 'plan'],
      ['scanned', 'scan'],
      ['opened', 'open'],
      ['listed', 'list'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(true);
    }
  });

  it('joins -ied with the -y form', () => {
    for (const [a, b] of [
      ['applied', 'apply'],
      ['verified', 'verify'],
      ['copied', 'copy'],
      ['retried', 'retry'],
      ['denied', 'deny'],
      ['classified', 'classify'],
      ['notified', 'notify'],
      ['tried', 'try'],
      ['supplied', 'supply'],
      ['carried', 'carry'],
      ['applied', 'applies'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(true);
    }
    expect(sameStem('applied', 'apple')).toBe(false);
  });

  it('joins the plural of an -ing noun with its singular, and the singular with nothing shorter', () => {
    for (const [a, b] of [
      ['settings', 'setting'],
      ['findings', 'finding'],
      ['warnings', 'warning'],
      ['bindings', 'binding'],
      ['headings', 'heading'],
      ['embeddings', 'embedding'],
      ['mappings', 'mapping'],
      ['listings', 'listing'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(true);
    }
    // The noun `setting` is not the verb `set`, nor `heading` the noun `head`.
    expect(sameStem('setting', 'set')).toBe(false);
    expect(sameStem('settings', 'set')).toBe(false);
    expect(sameStem('settings', 'sets')).toBe(false);
    expect(sameStem('heading', 'head')).toBe(false);
  });

  it('does not cut an -ed that belongs to the word', () => {
    for (const [a, b] of [
      ['speed', 'speeds'],
      ['embed', 'embeds'],
      ['embed', 'embedded'],
      ['embed', 'embedding'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(true);
    }
    for (const w of ['speed', 'exceed', 'proceed', 'succeed']) {
      expect(stemForms(w), w).toEqual([w]);
    }
    expect(sameStem('exceeds', 'exceed')).toBe(true);
    expect(sameStem('succeeds', 'succeed')).toBe(true);
    expect(sameStem('embed', 'emb')).toBe(false);
    expect(sameStem('speed', 'spee')).toBe(false);
  });

  it('joins -ses plurals with the singular without breaking use, case and base', () => {
    for (const [a, b] of [
      ['statuses', 'status'],
      ['aliases', 'alias'],
      ['canvases', 'canvas'],
      ['buses', 'bus'],
      ['addresses', 'address'],
      ['classes', 'class'],
    ] as const) {
      expect(sameStem(a, b), `${a}/${b}`).toBe(true);
    }
    expect(sameStem('uses', 'use')).toBe(true);
    expect(sameStem('cases', 'case')).toBe(true);
    expect(sameStem('bases', 'base')).toBe(true);
    expect(sameStem('causes', 'cause')).toBe(true);
    expect(sameStem('causes', 'caus')).toBe(false);
    expect(sameStem('statuses', 'statuse')).toBe(false);
  });

  it('is deterministic and lower-cases', () => {
    expect(stemForms('Approving')).toEqual(stemForms('approving'));
    expect(sameStem('Approving', 'approved')).toBe(true);
  });
});

describe('searchDocs with stemming', () => {
  const idx = buildSearchIndex([
    {
      content:
        '# Reviews\n\n## Approvals\n\nA reviewer approved the change, then approving again.\n\n' +
        '## Config\n\nSet AUTO_SWE_TOKEN and ciWaitMode.\n',
      slug: 'reviews',
      title: 'Reviews',
    },
    { content: '# Agents\n\n## Skills\n\nOne skill per file.\n', slug: 'agents', title: 'Agents' },
  ]);
  const ids = (q: string) => searchDocs(idx, q).map((r) => `${r.slug}#${r.anchor}`);

  it('finds the singular from a plural and the plural from a singular', () => {
    expect(ids('skills')).toContain('agents#skills');
    expect(ids('skill')).toContain('agents#skills');
    expect(ids('reviewers')).toEqual(['reviews#approvals']);
  });

  it('finds every inflection of approve', () => {
    for (const q of ['approve', 'approves', 'approved', 'approving', 'approval']) {
      expect(ids(q), q).toContain('reviews#approvals');
    }
  });

  it('highlights the text as written, not the query', () => {
    const [r] = searchDocs(idx, 'approves');
    const marked = r?.snippet.filter((s) => s.match).map((s) => s.text);
    expect(marked).toEqual(['approved', 'approving']);
    expect(r?.snippet.map((s) => s.text).join('')).toContain('A reviewer approved the change');
  });

  it('still matches identifiers and partial words by substring', () => {
    expect(ids('wait')).toEqual(['reviews#config']);
    expect(ids('auto_swe')).toEqual(['reviews#config']);
    expect(ids('ciwaitmode')).toEqual(['reviews#config']);
  });

  it('does not match unrelated words through a short stem', () => {
    expect(ids('bus')).toEqual([]);
    expect(ids('zebras')).toEqual([]);
  });

  it('keeps AND semantics across stemmed terms', () => {
    expect(ids('skills file')).toEqual(['agents#skills']);
    expect(ids('skills approving')).toEqual([]);
  });
});

describe('searchDocs does not conflate a bare word with a shorter one', () => {
  // Substring matching is separate and intended (`rat` is in `rate`), so the shorter word is
  // the one in the document and the longer one is the query.
  const idx = buildSearchIndex([
    { content: '# A\n\n## Short\n\nA rat, a bas, her, nam.\n', slug: 'short', title: 'A' },
    {
      content: '# B\n\n## Long\n\nThe rated, based, naming and hereby.\n',
      slug: 'long',
      title: 'B',
    },
  ]);
  const ids = (q: string) => searchDocs(idx, q).map((r) => r.slug);

  it('does not find rat, bas, her or nam from rate, base, here or name', () => {
    for (const q of ['rate', 'base', 'here', 'name']) {
      expect(ids(q), q).not.toContain('short');
    }
  });

  it('still finds the inflected forms of the longer word', () => {
    expect(ids('rate')).toEqual(['long']);
    expect(ids('base')).toEqual(['long']);
    expect(ids('name')).toEqual(['long']);
  });
});

describe('highlight with stems', () => {
  it('marks a word reached only through its stem, whole', () => {
    expect(highlight('Several skills here', ['skill'])).toEqual([
      { match: false, text: 'Several ' },
      { match: true, text: 'skill' },
      { match: false, text: 's here' },
    ]);
    expect(highlight('One skill here', ['skills'])).toEqual([
      { match: false, text: 'One ' },
      { match: true, text: 'skill' },
      { match: false, text: ' here' },
    ]);
  });
});

describe('stem equality, not stem prefix', () => {
  const idx = buildSearchIndex([
    {
      content:
        '# Guide\n\n## Spending\n\nTo spend less, and with a specific cascade, use the user guide. ' +
        'The bash tool runs commands.\n\n## Cases\n\nEach case is a test. Two cases fail.\n\n' +
        '## Using\n\nIt uses the policy. Use it. A series of runs. It does work.\n',
      slug: 'guide',
      title: 'Guide',
    },
  ]);
  const marked = (q: string) =>
    searchDocs(idx, q).flatMap((r) => r.snippet.filter((s) => s.match).map((s) => s.text));

  it('gives case and cases, use and uses, one stem each', () => {
    expect(sameStem('cases', 'case')).toBe(true);
    expect(sameStem('uses', 'use')).toBe(true);
    expect(sameStem('sizes', 'size')).toBe(true);
    expect(sameStem('based', 'base')).toBe(true);
    expect(sameStem('boxes', 'box')).toBe(true);
  });

  it('keeps speed apart from spend, and does and series intact', () => {
    expect(sameStem('speed', 'spend')).toBe(false);
    expect(stemForms('does')).toEqual(['does']);
    expect(stemForms('series')).toEqual(['series']);
    expect(sameStem('based', 'bash')).toBe(false);
    expect(sameStem('cases', 'cascade')).toBe(false);
    expect(sameStem('uses', 'user')).toBe(false);
    // `https` is a protocol name, not the plural of `http`.
    expect(sameStem('https', 'http')).toBe(false);
    // Possessive pronouns are not the plurals of `your` and `their`.
    expect(sameStem('yours', 'your')).toBe(false);
    expect(sameStem('theirs', 'their')).toBe(false);
  });

  it('finds nothing for speed, although spend and specific start the same way', () => {
    expect(searchDocs(idx, 'speed')).toEqual([]);
  });

  it('matches cases with case and highlights both', () => {
    expect(marked('cases')).toEqual(expect.arrayContaining(['case', 'cases']));
    expect(marked('case')).toEqual(expect.arrayContaining(['case']));
    expect(searchDocs(idx, 'case').length).toBeGreaterThan(0);
  });

  it('matches uses with use, but never user', () => {
    expect(marked('uses')).toEqual(expect.arrayContaining(['uses', 'Use']));
    expect(marked('uses')).not.toContain('user');
  });

  it('does not reach bash from based, and marks only the word itself for does and series', () => {
    expect(searchDocs(idx, 'based')).toEqual([]);
    expect(marked('does')).toEqual(['does']);
    expect(marked('series')).toEqual(['series']);
  });
});

describe('highlight ranges with characters that change length when lower-cased', () => {
  it('keeps the marked run on the original letters after an İ', () => {
    // `İ`.toLowerCase() is two code units; offsets from the lowered copy would drift by one.
    expect(highlight('İİ budget here', ['budget'])).toEqual([
      { match: false, text: 'İİ ' },
      { match: true, text: 'budget' },
      { match: false, text: ' here' },
    ]);
  });
});

describe('countMatchingTerms', () => {
  it('counts the query terms a text holds, by substring or stem', () => {
    expect(countMatchingTerms('Opens the pull request', 'pull requests zebra')).toBe(2);
    expect(countMatchingTerms('nothing here', 'pull')).toBe(0);
  });
});

/** A stemmer with docSearch's `stemForms` signature, so the check can be run on other rules. */
type Stemmer = (word: string) => string[];

/**
 * Function words and protocol names that a plural `s` strip must never merge with a base. A
 * plural of one of these is a different word (`theirs`, `yours`, `https`), not an inflection.
 */
const WATCH_BASES: ReadonlySet<string> = new Set([
  'our',
  'your',
  'their',
  'her',
  'his',
  'len',
  'rest',
  'http',
]);

/**
 * The merges this test reviews. Two distinct words that one stem covers, where the longer is the
 * shorter with `s` or `es` added, and the shorter is either vowelless (`http`, `jwt`, `sync`) or
 * in `WATCH_BASES`. Keys are `short/long`. Deterministic over the given vocabulary.
 *
 * Limits, stated so nothing reads as more than it is: a false merge whose base is neither
 * vowelless nor in `WATCH_BASES` is not flagged; missed inflections (`api`/`apis`, `gpu`/`gpus`,
 * `id`/`ids`, `pr`/`prs`: the stemmer does not join them) are not covered by this test at all.
 */
function flaggedMerges(vocabulary: string[], stem: Stemmer): Set<string> {
  const groups = new Map<string, string[]>();
  for (const word of new Set(vocabulary)) {
    for (const form of new Set(stem(word))) {
      groups.set(form, [...(groups.get(form) ?? []), word]);
    }
  }
  const flagged = new Set<string>();
  for (const group of groups.values()) {
    for (const short of group) {
      for (const long of group) {
        const plural = long === `${short}s` || long === `${short}es`;
        if (plural && (!/[aeiou]/.test(short) || WATCH_BASES.has(short))) {
          flagged.add(`${short}/${long}`);
        }
      }
    }
  }
  return flagged;
}

/**
 * Compares the flagged merges with the reviewed list. `unreviewed` must be empty: a flagged merge
 * nobody has reviewed. `stale` lists reviewed pairs the stemmer no longer merges. Staleness is
 * judged by the stemmer alone, so rewording a sentence in the docs does not fail the test.
 */
function mergeReport(
  flagged: Set<string>,
  reviewed: Readonly<Record<string, string>>,
  stem: Stemmer
): { unreviewed: string[]; stale: string[] } {
  const merges = (key: string) => {
    const [short = '', long = ''] = key.split('/');
    const forms = new Set(stem(short));
    return stem(long).some((form) => forms.has(form));
  };
  return {
    stale: Object.keys(reviewed)
      .filter((key) => !merges(key))
      .sort(),
    unreviewed: [...flagged].filter((key) => !(key in reviewed)).sort(),
  };
}

/**
 * Flagged merges a reviewer has checked and accepted as benign, each with its own reason. An
 * entry is stale, and fails the test, once the stemmer no longer merges its two words.
 */
const REVIEWED_COLLISIONS: Readonly<Record<string, string>> = {
  'ghe/ghes':
    'GHES and GHE both name GitHub Enterprise Server in the docs (GHE 14 times, GHES once, in pr-feedback.md); the rule does not flag it, and the stemmer merges it',
  'jwt/jwts':
    'JWTs: the plural of the acronym JWT (JSON Web Token), as in "sends session-bridge JWTs"',
  'prd/prds':
    'PRDs: the plural of the abbreviation PRD (product requirements document), as in "PRD runs"',
  'sync/syncs':
    'syncs: the third-person verb form of sync ("syncs the tracker"), not a noun plural',
};

/** The distinct words of the served docs' titles and sections, split as the index splits them. */
async function docsVocabulary(): Promise<string[]> {
  const index = await buildDocSearchIndexFromDir(
    fileURLToPath(new URL('../../../../docs', import.meta.url))
  );
  const vocabulary = new Set<string>();
  const add = (text: string) => {
    for (const { word } of words(text)) {
      vocabulary.add(word.toLowerCase());
    }
  };
  for (const doc of index.docs) {
    add(doc.title);
  }
  for (const section of index.sections) {
    add(section.text);
    add(section.heading ?? '');
  }
  return [...vocabulary].sort();
}

describe('docs vocabulary plural merges', () => {
  let vocabulary: string[] = [];
  // Building the index parses every served doc. Under parallel load that outruns the 5 s default.
  beforeAll(async () => {
    vocabulary = await docsVocabulary();
  }, 120_000);

  it('reads the served docs and their words', () => {
    expect(vocabulary.length).toBeGreaterThan(1000);
    expect(vocabulary).toContain('approval');
  });

  it('flags no vowelless or watch-set plural merge the reviewed list does not cover', () => {
    const flagged = flaggedMerges(vocabulary, stemForms);
    const { unreviewed, stale } = mergeReport(flagged, REVIEWED_COLLISIONS, stemForms);
    expect(
      unreviewed,
      'docs words merge a vowelless or watch-set word with its plural, not in REVIEWED_COLLISIONS: ' +
        `${unreviewed.join(', ')}. Either add a reviewed entry with a specific reason, or fix the ` +
        'stemmer lists in docSearch.ts if the pair is not a plural.'
    ).toEqual([]);
    expect(
      stale,
      `REVIEWED_COLLISIONS entries the stemmer no longer merges: ${stale.join(', ')}. Remove them.`
    ).toEqual([]);
  });

  it('reports a merge the pre-fix stemmer made, and suppresses it only when reviewed', () => {
    // Before `https` was listed as unstemmed, the plural rule gave it the stem of `http`.
    const preFix: Stemmer = (word) => (word === 'https' ? ['http'] : stemForms(word));
    const flagged = flaggedMerges(['http', 'https'], preFix);
    expect(flagged).toEqual(new Set(['http/https']));
    expect(mergeReport(flagged, {}, preFix)).toEqual({
      stale: [],
      unreviewed: ['http/https'],
    });
    expect(mergeReport(flagged, { 'http/https': 'reviewed' }, preFix)).toEqual({
      stale: [],
      unreviewed: [],
    });
  });

  it('flags a watch-set word and a vowelless word, but not an ordinary plural', () => {
    expect(flaggedMerges(['our', 'ours'], stemForms)).toEqual(new Set(['our/ours']));
    expect(flaggedMerges(['sync', 'syncs'], stemForms)).toEqual(new Set(['sync/syncs']));
    expect(flaggedMerges(['agent', 'agents', 'engine', 'engines'], stemForms).size).toBe(0);
  });

  it('reports a reviewed pair as stale once the stemmer no longer merges it', () => {
    // A stemmer that merges nothing: the reviewed pair no longer merges, so its entry is stale.
    const noMerges: Stemmer = (word) => [word];
    const flagged = flaggedMerges(['http', 'https'], stemForms);
    expect(mergeReport(flagged, { 'http/https': 'reviewed' }, noMerges)).toEqual({
      stale: ['http/https'],
      unreviewed: [],
    });
    // The same entry is not stale while the stemmer merges the pair, even if the docs lack it.
    expect(mergeReport(new Set(), { 'our/ours': 'reviewed' }, stemForms)).toEqual({
      stale: [],
      unreviewed: [],
    });
  });
});
