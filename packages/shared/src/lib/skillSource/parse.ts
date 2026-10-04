import { parse as parseYaml } from 'yaml';
import { MAX_SKILL_PROMPT_TEXT_LENGTH } from '../regexSafety.js';
import { safeDisplayPath } from './display.js';

/** The admin API's description cap. */
export const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_FRONTMATTER_LENGTH = 10_000;
/** Same bounds as `POST /platform/skills` (1–200), narrowed to a menu-safe charset. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;

export type ParsedSkillMd =
  | {
      ok: true;
      name: string;
      description: string;
      promptText: string;
      /** Frontmatter keys other than name/description (e.g. `allowed-tools`): read by nothing here. */
      ignoredKeys: string[];
    }
  | { ok: false; error: string };

/** Split `---`-fenced frontmatter from the body; null when there is none. */
function splitFrontmatter(text: string): { front: string; body: string } | null {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) {
    return null;
  }
  const end = src.indexOf('\n---', 3);
  if (end === -1) {
    return null;
  }
  const after = src.slice(end + 4);
  // The closing fence must be a line of its own.
  if (after !== '' && !after.startsWith('\n')) {
    return null;
  }
  return { body: after.replace(/^\n/, ''), front: src.slice(4, end) };
}

/**
 * Parse a `SKILL.md`: YAML frontmatter `name` and `description`, body → prompt
 * text. Every failure is a fixed per-skill string, never the parser's message
 * (which quotes the offending text).
 *
 * The description is flattened to one line: it is shown in the skill menu, where
 * a newline would let imported text start a menu entry or a heading of its own.
 */
export function parseSkillMd(text: string): ParsedSkillMd {
  const parts = splitFrontmatter(text);
  if (!parts) {
    return { error: 'SKILL.md has no YAML frontmatter', ok: false };
  }
  if (parts.front.length > MAX_FRONTMATTER_LENGTH) {
    return { error: 'frontmatter is too long', ok: false };
  }
  let data: unknown;
  try {
    // No aliases to speak of: bounds YAML alias expansion ("billion laughs").
    data = parseYaml(parts.front, { maxAliasCount: 0 });
  } catch {
    return { error: 'frontmatter is not valid YAML', ok: false };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'frontmatter is not a mapping', ok: false };
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    return {
      error: 'frontmatter name is missing or invalid (letters, digits, space . _ -, up to 200)',
      ok: false,
    };
  }
  if (typeof description !== 'string' || description.trim() === '') {
    return { error: 'frontmatter description is missing', ok: false };
  }
  // Control characters (U+0085 NEL among them, which some renderers treat as a line break
  // and `\s` does not match) become spaces.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control characters is the point
  const flat = description.replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  if (flat.length > MAX_DESCRIPTION_LENGTH) {
    return {
      error: `frontmatter description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
      ok: false,
    };
  }
  const promptText = parts.body.trim();
  if (promptText === '') {
    return { error: 'SKILL.md has no body', ok: false };
  }
  if (promptText.length > MAX_SKILL_PROMPT_TEXT_LENGTH) {
    return { error: `SKILL.md body exceeds ${MAX_SKILL_PROMPT_TEXT_LENGTH} characters`, ok: false };
  }
  const ignoredKeys = Object.keys(data as Record<string, unknown>)
    .filter((k) => k !== 'name' && k !== 'description')
    .slice(0, 20)
    .map((k) => safeDisplayPath(k).slice(0, 60));
  return { description: flat, ignoredKeys, name: name.trim(), ok: true, promptText };
}
