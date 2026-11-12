export class Denied extends Error {}

export type ObjectValue = Record<string, unknown>;

export function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Denied('expected an object');
  }
  return value as ObjectValue;
}

export function keys(value: ObjectValue, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Denied('unknown field');
  }
}

export function parseJson(input: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new Denied('invalid UTF-8');
  }
  let at = 0;
  const space = () => {
    while (/[\t\r\n ]/.test(text[at] ?? '\0')) {
      at++;
    }
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at++] === '"') {
        return JSON.parse(text.slice(start, at)) as string;
      }
      if (text[at - 1] === '\\') {
        at++;
      }
    }
    throw new Denied('invalid JSON string');
  };
  const value = (depth: number): unknown => {
    if (depth > 48) {
      throw new Denied('JSON too deep');
    }
    space();
    if (text[at] === '"') {
      return string();
    }
    if (text[at] === '{') {
      at++;
      const result = Object.create(null) as ObjectValue;
      space();
      if (text[at] === '}') {
        at++;
        return result;
      }
      while (at < text.length) {
        space();
        if (text[at] !== '"') {
          throw new Denied('invalid JSON key');
        }
        const key = string();
        if (Object.hasOwn(result, key)) {
          throw new Denied('duplicate JSON key');
        }
        space();
        if (text[at++] !== ':') {
          throw new Denied('invalid JSON object');
        }
        result[key] = value(depth + 1);
        space();
        const next = text[at++];
        if (next === '}') {
          return result;
        }
        if (next !== ',') {
          throw new Denied('invalid JSON object');
        }
      }
    } else if (text[at] === '[') {
      at++;
      const result: unknown[] = [];
      space();
      if (text[at] === ']') {
        at++;
        return result;
      }
      while (at < text.length) {
        result.push(value(depth + 1));
        space();
        const next = text[at++];
        if (next === ']') {
          return result;
        }
        if (next !== ',') {
          throw new Denied('invalid JSON array');
        }
      }
    } else {
      const token =
        /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
          text.slice(at)
        )?.[0];
      if (token) {
        at += token.length;
        return JSON.parse(token) as unknown;
      }
    }
    throw new Denied('invalid JSON');
  };
  try {
    const result = value(0);
    space();
    if (at !== text.length) {
      throw new Denied('trailing JSON');
    }
    return result;
  } catch (error) {
    if (error instanceof Denied) {
      throw error;
    }
    throw new Denied('invalid JSON');
  }
}
