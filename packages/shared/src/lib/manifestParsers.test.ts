import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FILES,
  parseCodeowners,
  parseGitmodules,
  parseManifest,
} from './manifestParsers.js';

describe('MANIFEST_FILES', () => {
  it('lists the supported manifest basenames', () => {
    expect(MANIFEST_FILES).toEqual([
      'package.json',
      'go.mod',
      'requirements.txt',
      'pom.xml',
      'Cargo.toml',
    ]);
  });
});

describe('parseManifest — package.json', () => {
  it('collects dependencies, devDependencies, and peerDependencies', () => {
    const content = JSON.stringify({
      dependencies: { react: '19.0.0', zod: '4.4.3' },
      devDependencies: { vitest: '4.1.10' },
      peerDependencies: { 'react-dom': '19.0.0' },
    });
    expect(parseManifest('package.json', content).sort()).toEqual(
      ['react', 'react-dom', 'vitest', 'zod'].sort()
    );
  });

  it('dedupes a name that appears in more than one section', () => {
    const content = JSON.stringify({
      dependencies: { zod: '4.4.3' },
      devDependencies: { zod: '4.4.3' },
    });
    expect(parseManifest('package.json', content)).toEqual(['zod']);
  });

  it('returns [] for malformed JSON', () => {
    expect(parseManifest('package.json', '{ not json')).toEqual([]);
  });

  it('returns [] when there are no dependency sections', () => {
    expect(parseManifest('package.json', JSON.stringify({ name: 'x' }))).toEqual([]);
  });

  it('returns [] for a top-level array', () => {
    expect(parseManifest('package.json', '[]')).toEqual([]);
  });

  it('dispatches on a nested path by basename', () => {
    expect(
      parseManifest(
        'services/api/package.json',
        JSON.stringify({ dependencies: { fastify: '5.11.0' } })
      )
    ).toEqual(['fastify']);
  });
});

describe('parseManifest — go.mod', () => {
  it('parses a require block', () => {
    const content = `module acme.com/payments

go 1.24

require (
\tgithub.com/acme/shared v1.2.3
\tgithub.com/acme/other v0.1.0 // indirect
)
`;
    expect(parseManifest('go.mod', content)).toEqual([
      'github.com/acme/shared',
      'github.com/acme/other',
    ]);
  });

  it('parses single-line requires', () => {
    const content = `module acme.com/payments

require github.com/acme/shared v1.2.3
require github.com/acme/other v0.1.0 // indirect
`;
    expect(parseManifest('go.mod', content)).toEqual([
      'github.com/acme/shared',
      'github.com/acme/other',
    ]);
  });

  it('returns [] for content with no requires', () => {
    expect(parseManifest('go.mod', 'module acme.com/payments\n\ngo 1.24\n')).toEqual([]);
  });
});

describe('parseManifest — requirements.txt', () => {
  it('strips version specifiers, comments, blank lines, and option flags', () => {
    const content = `
# a comment
requests==2.31.0
flask>=2.0,<3.0
-e git+https://github.com/acme/thing.git#egg=thing
-r other-requirements.txt
numpy~=1.26
django[bcrypt]>=4.0
plainname
`;
    expect(parseManifest('requirements.txt', content)).toEqual([
      'requests',
      'flask',
      'numpy',
      'django',
      'plainname',
    ]);
  });

  it('strips environment markers', () => {
    expect(parseManifest('requirements.txt', 'foo==1.0; python_version < "3.8"')).toEqual(['foo']);
  });

  it('returns [] for an empty file', () => {
    expect(parseManifest('requirements.txt', '\n\n  \n')).toEqual([]);
  });
});

describe('parseManifest — pom.xml', () => {
  it('extracts groupId:artifactId from each dependency block', () => {
    const content = `<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework</groupId>
      <artifactId>spring-core</artifactId>
      <version>6.1.0</version>
    </dependency>
    <dependency>
      <groupId>com.acme</groupId>
      <artifactId>acme-lib</artifactId>
    </dependency>
  </dependencies>
</project>`;
    expect(parseManifest('pom.xml', content)).toEqual([
      'org.springframework:spring-core',
      'com.acme:acme-lib',
    ]);
  });

  it('returns [] when a dependency block is missing groupId or artifactId', () => {
    const content = `<dependency><artifactId>orphan</artifactId></dependency>`;
    expect(parseManifest('pom.xml', content)).toEqual([]);
  });

  it('returns [] for content with no dependency tags', () => {
    expect(parseManifest('pom.xml', '<project></project>')).toEqual([]);
  });
});

describe('parseManifest — Cargo.toml', () => {
  it('collects keys from [dependencies] and [dev-dependencies]', () => {
    const content = `[package]
name = "acme"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
mockall = "0.12"
`;
    expect(parseManifest('Cargo.toml', content)).toEqual(['serde', 'tokio', 'mockall']);
  });

  it('captures [dependencies.name] sub-table headers', () => {
    const content = `[dependencies.serde]
version = "1.0"
features = ["derive"]
`;
    expect(parseManifest('Cargo.toml', content)).toEqual(['serde']);
  });

  it('does not leak keys from unrelated sections', () => {
    const content = `[package]
name = "acme"
version = "0.1.0"
`;
    expect(parseManifest('Cargo.toml', content)).toEqual([]);
  });
});

describe('parseManifest — unknown files', () => {
  it('returns [] for an unrecognized basename', () => {
    expect(parseManifest('README.md', 'anything')).toEqual([]);
  });
});

describe('parseGitmodules', () => {
  it('extracts submodule URLs', () => {
    const content = `[submodule "vendor/foo"]
\tpath = vendor/foo
\turl = https://github.com/acme/foo.git

[submodule "vendor/bar"]
\tpath = vendor/bar
\turl = git@github.com:acme/bar.git
`;
    expect(parseGitmodules(content)).toEqual([
      'https://github.com/acme/foo.git',
      'git@github.com:acme/bar.git',
    ]);
  });

  it('returns [] for content with no submodules', () => {
    expect(parseGitmodules('')).toEqual([]);
  });
});

describe('parseCodeowners', () => {
  it('extracts owner tokens, ignoring the path pattern and comments', () => {
    const content = `# comment
* @acme/platform-eng
/docs/ @jane @acme/docs-team
/legacy/ someone@acme.com
`;
    expect(parseCodeowners(content)).toEqual([
      '@acme/platform-eng',
      '@jane',
      '@acme/docs-team',
      'someone@acme.com',
    ]);
  });

  it('returns [] for content with no owner lines', () => {
    expect(parseCodeowners('# just a comment\n\n')).toEqual([]);
  });
});
