/**
 * Runs ONE real Pi implementer turn, end to end, outside Temporal and without a
 * database: a hardened Docker container, the Pi runtime with a real model, a
 * report of every tool call, model call, the diff and the cost. The logic is in
 * `src/agents/pi/smoke.ts`; this is its command line.
 *
 *   PI_SMOKE_API_KEY=<key> yarn pi:smoke --model anthropic/claude-sonnet-5-5 --no-db-scanners
 *   yarn pi:smoke --mock --no-db-scanners        # scripted model: no key, no network
 *
 * `yarn pi:smoke --help` lists the options. The key is read only from
 * `PI_SMOKE_API_KEY`.
 */
// Only the argument module is loaded before the checks below: the worker's modules build the
// shared Prisma client when they load, which needs a DATABASE_URL.
import { parseSmokeArgs, SMOKE_USAGE } from '../src/agents/pi/smokeArgs.js';

// The root `pi:smoke` script passes the caller's directory (a nested `yarn workspace … exec`
// resets INIT_CWD to this package), so relative --dir and --trace-file mean the caller's.
if (process.env.PI_SMOKE_CWD) {
  process.chdir(process.env.PI_SMOKE_CWD);
}

try {
  const options = parseSmokeArgs(process.argv.slice(2));
  if (options === 'help') {
    console.log(SMOKE_USAGE);
  } else {
    // The key lives in this process only: nothing it starts (docker, git) inherits it.
    delete process.env.PI_SMOKE_API_KEY;
    if (!process.env.DATABASE_URL) {
      if (!options.noDbScanners) {
        throw new Error(
          'The scanners read their patterns from the database and DATABASE_URL is not set.\n' +
            'Set it, or pass --no-db-scanners to run them against the built-in pattern list\n' +
            '(an explicit, labelled mode: patterns an admin added or disabled are not applied).'
        );
      }
      // Loading the worker's modules constructs the Prisma client, which needs a URL even
      // though, in this mode, nothing connects.
      process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
    }
    const { formatReport, runSmoke } = await import('../src/agents/pi/smoke.js');
    const { report } = await runSmoke({ ...options, log: (line) => console.error(line) });
    console.log(`\n${formatReport(report)}`);
    console.log(`\nFull trace: ${options.traceFile}`);
    // The turn's own failure is the result: a smoke run that errored must not look green.
    process.exitCode = report.error ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
}
// Pi's loop and the model client can leave handles open; the report is already printed.
process.exit();
