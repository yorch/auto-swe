import { describe, expect, it } from 'vitest';
import { isSmallMavenFile, mavenContentType, parseMavenPath } from './mavenProxy.js';

describe('parseMavenPath', () => {
  it('parses a release file and keeps the path without its leading slash', () => {
    expect(
      parseMavenPath('/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar')
    ).toEqual({
      kind: 'release',
      path: 'org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar',
    });
    expect(parseMavenPath('/a/b/1.0/b-1.0-sources.jar.sha1')?.kind).toBe('release');
    expect(parseMavenPath('/a/b_c/1.0+build~1/b_c-1.0+build~1.pom')?.kind).toBe('release');
  });

  it('classifies metadata, whatever directory it sits in', () => {
    for (const p of [
      '/a/b/maven-metadata.xml',
      '/a/b/maven-metadata.xml.sha1',
      '/a/b/1.0-SNAPSHOT/maven-metadata.xml',
      '/a/b/maven-metadata-central.xml',
    ]) {
      expect(parseMavenPath(p)?.kind, p).toBe('metadata');
    }
  });

  it('classifies a snapshot by its directory, its file name or a timestamped name', () => {
    for (const p of [
      '/a/b/1.0-SNAPSHOT/b-1.0-SNAPSHOT.jar',
      '/a/b/1.0-SNAPSHOT/b-1.0-20240101.123456-7.jar',
      '/a/b/1.0-SNAPSHOT/b-1.0-20240101.123456-7-sources.jar',
      '/a/b/1.0/b-1.0-SNAPSHOT.jar',
      '/a/b/1.0/b-1.0-20240101.123456-7.pom',
      '/a/b/1.0-snapshot/b-1.0-snapshot.jar',
    ]) {
      expect(parseMavenPath(p)?.kind, p).toBe('snapshot');
    }
    // A build number or a date that is not a timestamp is still a release.
    expect(parseMavenPath('/a/b/20240101/b-20240101.jar')?.kind).toBe('release');
  });

  it('refuses anything that is not a plain file path', () => {
    const long = 'a'.repeat(201);
    const deep = `/${Array.from({ length: 25 }, () => 'a').join('/')}.jar`;
    const many = `/${Array.from({ length: 23 }, () => 'a').join('/')}/b.jar`;
    for (const p of [
      '',
      'a/b/1.0/b-1.0.jar',
      '/',
      '/a/b/1.0/',
      '/a/b/c',
      '/a//b.jar',
      '/a/./b.jar',
      '/a/../b.jar',
      '/a/b/..',
      '/a/.hidden/b.jar',
      '/.a/b.jar',
      '/-a/b.jar',
      '/a/b%2e%2e/c.jar',
      '/a/%2e%2e/c.jar',
      '/a/b%20c.jar',
      '/a\\b.jar',
      '/a/b.jar?x=1',
      '/a/b.jar#x',
      '/a/b c.jar',
      '/a/b\u0000.jar',
      '/a/b\n.jar',
      '/a/é.jar',
      '/a/@b/c.jar',
      `/${long}/b.jar`,
      `/a/${long}.jar`,
      deep,
    ]) {
      expect(parseMavenPath(p), JSON.stringify(p)).toBeNull();
    }
    expect(parseMavenPath(many)).not.toBeNull();
  });

  it('bounds the path to 1,000 characters', () => {
    const seg = 'a'.repeat(100);
    const ok = `/${Array.from({ length: 9 }, () => seg).join('/')}/b.jar`;
    expect(ok.length).toBeLessThanOrEqual(1001);
    expect(parseMavenPath(ok)).not.toBeNull();
    const tooLong = `/${Array.from({ length: 10 }, () => seg).join('/')}/b.jar`;
    expect(tooLong.length).toBeGreaterThan(1001);
    expect(parseMavenPath(tooLong)).toBeNull();
  });
});

describe('maven file classes', () => {
  it('runs small text files under a deadline and lets archives stream', () => {
    for (const f of [
      'a.pom',
      'a.xml',
      'a.jar.sha1',
      'a.md5',
      'a.sha256',
      'a.sha512',
      'a.asc',
      'a.module',
      'a.json',
    ]) {
      expect(isSmallMavenFile(f), f).toBe(true);
    }
    for (const f of ['a.jar', 'a.zip', 'a.aar', 'a.war', 'a.tar.gz', 'a.klib', 'a.exe']) {
      expect(isSmallMavenFile(f), f).toBe(false);
    }
  });

  it('answers a fixed content type per extension', () => {
    expect(mavenContentType('a/b.pom')).toBe('application/xml');
    expect(mavenContentType('a/maven-metadata.xml')).toBe('application/xml');
    expect(mavenContentType('a/b.module')).toBe('application/json');
    expect(mavenContentType('a/b.jar.sha1')).toBe('text/plain; charset=utf-8');
    expect(mavenContentType('a/b.jar')).toBe('application/octet-stream');
  });
});
