import { describe, expect, it } from 'vitest';
import { withSchemaInstruction } from './schemaInPrompt.js';

type Params = Parameters<typeof withSchemaInstruction>[0];

const schema = { properties: { verdict: { type: 'string' } }, type: 'object' } as const;
const user = { content: [{ text: 'hi', type: 'text' as const }], role: 'user' as const };

describe('withSchemaInstruction', () => {
  it('appends the schema to an existing system message', () => {
    const params: Params = {
      prompt: [{ content: 'SYS', role: 'system' }, user],
      responseFormat: { schema, type: 'json' },
    };
    const out = withSchemaInstruction(params);
    expect(out.prompt).toHaveLength(2);
    const first = out.prompt[0];
    expect(first?.role).toBe('system');
    expect(first?.role === 'system' && first.content).toMatch(/^SYS\n\nRespond with a single JSON/);
    expect(first?.role === 'system' && first.content).toContain(JSON.stringify(schema));
  });

  it('adds a system message when the prompt has none', () => {
    const out = withSchemaInstruction({ prompt: [user], responseFormat: { schema, type: 'json' } });
    expect(out.prompt).toHaveLength(2);
    expect(out.prompt[0]?.role).toBe('system');
    expect(out.prompt[1]).toBe(user);
  });

  it('leaves text calls and schemaless JSON calls alone', () => {
    const text: Params = { prompt: [user] };
    expect(withSchemaInstruction(text)).toBe(text);
    const bare: Params = { prompt: [user], responseFormat: { type: 'json' } };
    expect(withSchemaInstruction(bare)).toBe(bare);
  });
});
