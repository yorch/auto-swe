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

// `yarn workspace … exec` runs from packages/worker; relative --dir/--trace-file paths mean the caller's.
if (process.env.INIT_CWD) {
  process.chdir(process.env.INIT_CWD);
}

// The worker's modules construct the shared Prisma client when they load, and that needs a
// DATABASE_URL even though nothing connects. In the explicit built-in-scanner mode a placeholder
// stands in; otherwise the scanners really read the database, so a missing URL is an error.
const builtinScanners =
  process.argv.includes('--no-db-scanners') || process.env.PI_SMOKE_NO_DB_SCANNERS === '1';
const wantsHelp = process.argv.includes('--help');
if (!process.env.DATABASE_URL && !wantsHelp) {
  if (!builtinScanners) {
    console.error(
      'The scanners read their patterns from the database and DATABASE_URL is not set.\n' +
        'Set it, or pass --no-db-scanners to run them against the built-in pattern list\n' +
        '(an explicit, labelled mode: patterns an admin added or disabled are not applied).'
    );
    process.exit(2);
  }
  process.env.DATABASE_URL = 'postgresql://smoke:smoke@127.0.0.1:1/smoke';
}

const { formatReport, parseSmokeArgs, runSmoke, SMOKE_USAGE } = await import(
  '../src/agents/pi/smoke.js'
);

try {
  const options = parseSmokeArgs(process.argv.slice(2));
  if (options === 'help') {
    console.log(SMOKE_USAGE);
  } else {
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
