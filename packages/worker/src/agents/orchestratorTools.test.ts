import { describe, expect, it } from 'vitest';
import {
  createOrchestratorTools,
  IntentCollector,
  MAX_INTENTS_PER_TURN,
} from './orchestratorTools.js';

type Exec = (input: unknown) => Promise<{ recorded: boolean; note: string }>;
function tools() {
  const collector = new IntentCollector();
  const t = createOrchestratorTools(collector) as unknown as Record<string, { execute: Exec }>;
  return {
    collector,
    run: (name: string, input: unknown) => (t[name] as { execute: Exec }).execute(input),
  };
}

const reader = { agent: 'docsMaintainer', label: 'read', role: 'reader', task: 'read it' };
const writer = {
  agent: 'implementer',
  deliver: 'draft_pr',
  label: 'edit',
  pathScopes: ['src/lib/**'],
  role: 'writer',
  task: 'edit it',
};

describe('orchestrator intent tools', () => {
  it('records valid intents without doing anything else', async () => {
    const { collector, run } = tools();
    expect((await run('spawnAgent', reader)).recorded).toBe(true);
    expect((await run('spawnAgent', writer)).recorded).toBe(true);
    expect((await run('messageAgent', { childId: 'c1', message: 'hello' })).recorded).toBe(true);
    expect((await run('cancelAgent', { childId: 'c1' })).recorded).toBe(true);
    expect((await run('requestRepo', { reason: 'need code' })).recorded).toBe(true);
    expect(collector.intents.map((i) => i.kind)).toEqual([
      'spawn',
      'spawn',
      'message',
      'cancel',
      'requestRepo',
    ]);
  });

  it.each([
    ['a writer with no path scope', { ...writer, pathScopes: [] }],
    ['a writer with no delivery', { ...writer, deliver: undefined }],
    ['a traversing scope', { ...writer, pathScopes: ['../etc/**'] }],
    ['a reader that delivers', { ...reader, deliver: 'branch' }],
    ['an unknown role', { ...reader, role: 'root' }],
    ['no label', { ...reader, label: '' }],
  ])('rejects %s and records nothing', async (_name, input) => {
    const { collector, run } = tools();
    // Mastra validates the input before `execute`, so a malformed call never reaches the collector.
    const ack = await run('spawnAgent', input);
    expect(ack.recorded).not.toBe(true);
    expect(collector.intents).toEqual([]);
  });

  it('rejects malformed message, cancel and repo requests', async () => {
    const { collector, run } = tools();
    expect((await run('messageAgent', { childId: 'c1', message: '' })).recorded).not.toBe(true);
    expect((await run('cancelAgent', {})).recorded).not.toBe(true);
    expect((await run('requestRepo', { candidate: 'not-a-uuid', reason: 'x' })).recorded).not.toBe(
      true
    );
    expect(collector.intents).toEqual([]);
  });

  it('records at most one repository request per turn', async () => {
    const { collector, run } = tools();
    expect((await run('requestRepo', { reason: 'one' })).recorded).toBe(true);
    expect((await run('requestRepo', { reason: 'two' })).recorded).toBe(false);
    expect(collector.intents).toHaveLength(1);
  });

  it('caps the intents of one turn', async () => {
    const { collector, run } = tools();
    for (let i = 0; i < MAX_INTENTS_PER_TURN + 3; i++) {
      await run('cancelAgent', { childId: `c${i}` });
    }
    expect(collector.intents).toHaveLength(MAX_INTENTS_PER_TURN);
  });

  it('gives the collector a copy, so a caller cannot edit the record', async () => {
    const { collector, run } = tools();
    await run('cancelAgent', { childId: 'c1' });
    collector.intents.pop();
    expect(collector.intents).toHaveLength(1);
  });
});
