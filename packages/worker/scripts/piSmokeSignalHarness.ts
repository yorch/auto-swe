/**
 * A minimal process around `runSmoke` for `src/agents/pi/smoke.docker.test.ts`, which sends it a
 * real SIGINT: an event-emitter test cannot see what other signal listeners in
 * the process (a `signal-exit` hook, say) do to the handler. It runs a scripted
 * turn that blocks in `sleep`, so the signal arrives mid-turn.
 *
 *   node --import tsx scripts/piSmokeSignalHarness.ts   (PI_SMOKE_HARNESS_IMAGE, PI_SMOKE_HARNESS_DIR)
 */
import { runSmoke, scriptedModel } from '../src/agents/pi/smoke.js';

process.env.DATABASE_URL ||= 'postgresql://smoke:smoke@127.0.0.1:1/smoke';

await runSmoke({
  deadlineSeconds: 300,
  dir: process.env.PI_SMOKE_HARNESS_DIR,
  image: process.env.PI_SMOKE_HARNESS_IMAGE ?? 'node:24-alpine',
  languageModel: scriptedModel([
    { calls: [{ input: { command: 'sleep 300' }, name: 'bash' }] },
    { text: 'done' },
  ]),
  log: (line) => console.log(line),
  maxSteps: 4,
  mock: true,
  model: 'anthropic/claude-sonnet-5-5',
  noDbScanners: true,
  prompt: 'go',
});
process.exit(0);
