import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyAddress,
  createGuardedFetch,
  createOriginScopedFetch,
  type HostResolver,
  makeGuardedLookup,
  type ResolvedAddress,
  resolveAndCheck,
  SsrfBlockedError,
} from './guardedDispatcher.js';

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });
const resolverOf =
  (...addresses: ResolvedAddress[]): HostResolver =>
  async () =>
    addresses;

describe('classifyAddress', () => {
  it.each([
    ['93.184.216.34', 'ok'],
    ['2606:2800:220:1:248:1893:25c8:1946', 'ok'],
    ['10.1.1.17', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fc00::1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['127.0.0.1', 'never'],
    ['::1', 'never'],
    ['::ffff:127.0.0.1', 'never'],
    ['0.0.0.0', 'never'],
    ['::', 'never'],
    ['169.254.169.254', 'never'],
    ['::ffff:169.254.169.254', 'never'],
    ['fe80::1', 'never'],
    ['fe80::1%eth0', 'never'],
    ['fd00:ec2::254', 'never'],
    ['100.100.100.200', 'never'],
    ['224.0.0.1', 'never'],
    ['255.255.255.255', 'never'],
    ['ff02::1', 'never'],
    ['not-an-ip', 'never'],
  ])('%s is %s without the opt-in', (address, verdict) => {
    expect(classifyAddress(address)).toBe(verdict);
  });

  it('waives only the private class with allowPrivate', () => {
    expect(classifyAddress('10.1.1.17', true)).toBe('ok');
    expect(classifyAddress('100.64.0.1', true)).toBe('ok');
    expect(classifyAddress('fd12:3456::1', true)).toBe('ok');
    for (const never of [
      '127.0.0.1',
      '::1',
      '169.254.169.254',
      'fd00:ec2::254',
      '100.100.100.200',
      '0.0.0.0',
    ]) {
      expect(classifyAddress(never, true)).toBe('never');
    }
  });
});

describe('resolveAndCheck', () => {
  it('returns every address when all are public', async () => {
    const out = await resolveAndCheck('example.com', {
      resolver: resolverOf(v4('93.184.216.34'), v6('2606:2800:220:1::1')),
    });
    expect(out).toHaveLength(2);
  });

  it('refuses when any one of several records is refused', async () => {
    await expect(
      resolveAndCheck('mixed.example', {
        resolver: resolverOf(v4('93.184.216.34'), v4('10.1.1.17')),
      })
    ).rejects.toThrow(/private network/);
    await expect(
      resolveAndCheck('mixed.example', {
        allowPrivate: true,
        resolver: resolverOf(v4('10.1.1.17'), v4('169.254.169.254')),
      })
    ).rejects.toThrow(/never allowed/);
  });

  it('refuses a public name that resolves to a private address, unless opted in', async () => {
    const resolver = resolverOf(v4('10.1.1.17'));
    await expect(resolveAndCheck('10.1.1.17.nip.io', { resolver })).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
    await expect(
      resolveAndCheck('10.1.1.17.nip.io', { allowPrivate: true, resolver })
    ).resolves.toEqual([v4('10.1.1.17')]);
  });

  it('never waives loopback, even with the opt-in', async () => {
    await expect(
      resolveAndCheck('rebind.example', {
        allowPrivate: true,
        resolver: resolverOf(v4('127.0.0.1')),
      })
    ).rejects.toThrow(/never allowed/);
  });

  it('fails closed on a DNS failure, an empty answer and a timeout, with a fixed message', async () => {
    const msg = "host 'x.example' could not be resolved";
    await expect(
      resolveAndCheck('x.example', {
        resolver: async () => {
          throw new Error('ENOTFOUND secret-resolver-detail');
        },
      })
    ).rejects.toThrow(msg);
    await expect(resolveAndCheck('x.example', { resolver: resolverOf() })).rejects.toThrow(msg);
    await expect(
      resolveAndCheck('x.example', { dnsTimeoutMs: 20, resolver: () => new Promise(() => {}) })
    ).rejects.toThrow(msg);
  });

  it('classifies an IP literal without resolving', async () => {
    const resolver = vi.fn();
    await expect(resolveAndCheck('[::1]', { resolver })).rejects.toThrow(/never allowed/);
    await expect(resolveAndCheck('93.184.216.34', { resolver })).resolves.toHaveLength(1);
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('makeGuardedLookup (pinning)', () => {
  const run = (lookup: ReturnType<typeof makeGuardedLookup>, host: string, options: object) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) => {
      lookup(host, options, (err, address, family) => resolve({ address, err, family }));
    });

  it('resolves once and returns only checked addresses', async () => {
    // A rebinding resolver: public first, private on any later call.
    const resolver = vi
      .fn<HostResolver>()
      .mockResolvedValueOnce([v4('93.184.216.34')])
      .mockResolvedValue([v4('10.0.0.5')]);
    const lookup = makeGuardedLookup({ resolver });
    const first = await run(lookup, 'rebind.example', { all: true });
    expect(first.err).toBeNull();
    expect(first.address).toEqual([v4('93.184.216.34')]);
    expect(resolver).toHaveBeenCalledTimes(1);
    // The next connection gets its own check, and the private answer is refused.
    const second = await run(lookup, 'rebind.example', { all: true });
    expect(second.err).toBeInstanceOf(SsrfBlockedError);
  });

  it('honours the family and the single-address callback form', async () => {
    const lookup = makeGuardedLookup({
      resolver: resolverOf(v6('2606:2800:220:1::1'), v4('93.184.216.34')),
    });
    const r = await run(lookup, 'dual.example', { family: 4 });
    expect(r.address).toBe('93.184.216.34');
    expect(r.family).toBe(4);
  });

  it('refuses the whole set when one address is bad, rather than offering the good one', async () => {
    const lookup = makeGuardedLookup({
      resolver: resolverOf(v4('93.184.216.34'), v4('192.168.0.9')),
    });
    const r = await run(lookup, 'mixed.example', { all: true });
    expect(r.err).toBeInstanceOf(SsrfBlockedError);
    expect(r.address).toBeUndefined();
  });
});

describe('createGuardedFetch', () => {
  it('refuses a name that resolves internally before any request is sent', async () => {
    let hit = false;
    const server = createServer((_req, res) => {
      hit = true;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const guarded = createGuardedFetch({ resolver: resolverOf(v4('127.0.0.1')) });
      await expect(guarded(`http://rebind.example:${port}/`)).rejects.toBeInstanceOf(
        SsrfBlockedError
      );
      expect(hit).toBe(false);
    } finally {
      server.close();
    }
  });

  it('refuses a literal IP without dispatching', async () => {
    const fetchImpl = vi.fn();
    const guarded = createGuardedFetch({ fetchImpl });
    await expect(guarded('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes the pinned dispatcher to the underlying fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const guarded = createGuardedFetch({ fetchImpl, proxied: false });
    await guarded('https://example.com/a', { method: 'POST' });
    expect(fetchImpl.mock.calls[0][1].dispatcher).toBeDefined();
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });

  it('under an environment proxy checks the host up front and leaves dispatch to the process', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const bad = createGuardedFetch({
      fetchImpl,
      proxied: true,
      resolver: resolverOf(v4('10.0.0.1')),
    });
    await expect(bad('https://x.example/')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
    const ok = createGuardedFetch({
      fetchImpl,
      proxied: true,
      resolver: resolverOf(v4('93.184.216.34')),
    });
    await ok('https://x.example/');
    expect(fetchImpl.mock.calls[0][1]?.dispatcher).toBeUndefined();
  });
});

describe('createOriginScopedFetch', () => {
  it('waives the private refusal for the listed origin only', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('ok'));
    // `proxied` makes the up-front host check run, so the resolver decides.
    const scoped = createOriginScopedFetch(['https://ghe.corp.example'], {
      fetchImpl,
      proxied: true,
      resolver: resolverOf(v4('10.0.0.1')),
    });
    await scoped('https://ghe.corp.example/logs');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(scoped('https://blob.example.net/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never waives loopback for a listed origin', async () => {
    const scoped = createOriginScopedFetch(['https://ghe.corp.example'], {
      fetchImpl: vi.fn(),
      proxied: true,
      resolver: resolverOf(v4('127.0.0.1')),
    });
    await expect(scoped('https://ghe.corp.example/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });
});
