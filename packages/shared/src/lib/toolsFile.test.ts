import { describe, expect, it } from 'vitest';
import { ToolInstallError } from './toolCatalog.js';
import {
  MAX_TOOLS_FILE_BYTES,
  MAX_TOOLS_IN_FILE,
  mergeToolRequests,
  parseToolsFile,
  renderToolsFile,
  TOOLS_FILE_PATH,
  ToolsFileError,
} from './toolsFile.js';

const catchError = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('parseToolsFile', () => {
  it('parses tools with and without an explicit version', () => {
    const text = 'version: 1\ntools:\n  - key: just\n    version: "1.40.0"\n  - key: jq\n';
    expect(parseToolsFile(text)).toEqual([{ key: 'just', version: '1.40.0' }, { key: 'jq' }]);
  });

  it('returns an empty list for an empty tools list', () => {
    expect(parseToolsFile('version: 1\ntools: []\n')).toEqual([]);
  });

  it('returns an empty list when the tools key is missing', () => {
    expect(parseToolsFile('version: 1\n')).toEqual([]);
  });

  const generatedTools = Array.from(
    { length: MAX_TOOLS_IN_FILE + 1 },
    (_, i) => `  - key: t${i}`
  ).join('\n');

  it.each<[string, string]>([
    ['an unknown top-level key', 'version: 1\nextra: true\n'],
    ['an unknown key inside a tool', 'version: 1\ntools:\n  - key: jq\n    url: https://x\n'],
    ['version 2', 'version: 2\ntools: []\n'],
    ['a missing version', 'tools: []\n'],
    ['a YAML alias', 'version: 1\ntools:\n  - &t\n    key: jq\n  - *t\n'],
    ['duplicate YAML keys', 'version: 1\nversion: 1\n'],
    ['a duplicate tool key', 'version: 1\ntools:\n  - key: jq\n  - key: jq\n'],
    ['more than the maximum number of tools', `version: 1\ntools:\n${generatedTools}\n`],
    ['text over the byte limit', `# ${'a'.repeat(MAX_TOOLS_FILE_BYTES)}\nversion: 1\n`],
    ['non-YAML garbage', 'version: [1, 2\n'],
    ['a tool key with uppercase letters', 'version: 1\ntools:\n  - key: Jq\n'],
    ['a tool key with a semicolon', 'version: 1\ntools:\n  - key: "jq;rm"\n'],
  ])('refuses %s with a non-retryable ToolsFileError', (_label, text) => {
    const error = catchError(() => parseToolsFile(text));
    expect(error).toBeInstanceOf(ToolsFileError);
    expect((error as ToolsFileError).retryable).toBe(false);
  });
});

describe('renderToolsFile', () => {
  const tools = [{ key: 'just', version: '1.40.0' }, { key: 'jq' }];

  it('renders text that parses back to the same tools, sorted by key', () => {
    expect(parseToolsFile(renderToolsFile(tools))).toEqual([
      { key: 'jq' },
      { key: 'just', version: '1.40.0' },
    ]);
  });

  it('does not depend on the input order', () => {
    expect(renderToolsFile(tools)).toBe(renderToolsFile([...tools].reverse()));
  });

  it('sorts by plain code-unit order, not by the process locale', () => {
    // localeCompare puts '_' before '1'; code-unit order puts '1' (0x31) before '_' (0x5f).
    const text = renderToolsFile([{ key: 'a_b' }, { key: 'a1b' }]);
    expect(parseToolsFile(text).map((t) => t.key)).toEqual(['a1b', 'a_b']);
  });

  it('is deterministic', () => {
    expect(renderToolsFile(tools)).toBe(renderToolsFile(tools));
  });

  it('starts with the header comment naming the file', () => {
    const text = renderToolsFile(tools);
    expect(text.startsWith('# auto-swe on-demand tools')).toBe(true);
    expect(text).toContain(TOOLS_FILE_PATH);
  });

  it('throws for a request with a bad key', () => {
    expect(() => renderToolsFile([{ key: 'Bad Key' }])).toThrow();
  });
});

describe('mergeToolRequests', () => {
  it('lets an admin entry win over the file entry for the same key', () => {
    const merged = mergeToolRequests(
      {
        admin: [{ key: 'just', version: '1.40.0' }],
        deny: [],
        file: [{ key: 'just', version: '1.39.0' }, { key: 'jq' }],
      },
      10
    );
    expect(merged).toEqual([{ key: 'just', version: '1.40.0' }, { key: 'jq' }]);
  });

  it('removes denied keys from both the admin list and the file', () => {
    const merged = mergeToolRequests(
      { admin: [{ key: 'a' }], deny: ['a', 'b'], file: [{ key: 'b' }] },
      10
    );
    expect(merged).toEqual([]);
  });

  it('throws a ToolInstallError naming the maxTools setting when over the limit', () => {
    const error = catchError(() =>
      mergeToolRequests({ admin: [{ key: 'a' }, { key: 'b' }], deny: [], file: [{ key: 'c' }] }, 2)
    );
    expect(error).toBeInstanceOf(ToolInstallError);
    expect((error as ToolInstallError).message).toMatch(/workspace\.toolInstall\.maxTools/);
  });

  it('passes when the result is exactly the maximum', () => {
    const merged = mergeToolRequests(
      { admin: [{ key: 'a' }, { key: 'b' }], deny: [], file: [] },
      2
    );
    expect(merged).toHaveLength(2);
  });

  it('returns an empty list for empty inputs', () => {
    expect(mergeToolRequests({ admin: [], deny: [], file: [] }, 0)).toEqual([]);
  });
});
