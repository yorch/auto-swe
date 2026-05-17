'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/stores/authStore';

export default function LoginPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      router.push('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* LEFT: editorial panel */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-ink-600 bg-ink-950 p-12 lg:flex">
        {/* Atmospheric glow + grid */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'radial-gradient(circle at 30% 20%, rgba(226,107,60,0.18), transparent 55%),' +
              'radial-gradient(circle at 80% 80%, rgba(133,166,197,0.10), transparent 55%)',
          }}
        />
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, var(--color-paper-500) 1px, transparent 1px),' +
              'linear-gradient(to bottom, var(--color-paper-500) 1px, transparent 1px)',
            backgroundSize: '64px 64px',
          }}
        />

        <header className="relative z-10 flex items-center justify-between">
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-3xl font-medium leading-none tracking-tight text-paper-50">
                auto
              </span>
              <span className="display-italic text-3xl leading-none text-ember-400">·swe</span>
            </div>
            <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
              engineering · telemetry · v0.1
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-moss-400" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-400">
              control plane online
            </span>
          </div>
        </header>

        <div className="relative z-10 max-w-xl space-y-8">
          <div className="fade-up">
            <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.24em] text-ember-400">
              ¶ Manifesto
            </div>
            <p className="font-display text-[44px] font-light leading-[1.1] tracking-tight text-paper-50">
              A workshop for{' '}
              <span className="display-italic text-ember-300">software at scale</span>
              <span className="text-ember-400">.</span>
            </p>
          </div>
          <p className="fade-up stagger-2 max-w-md text-base leading-relaxed text-paper-300">
            Coordinate fleets of engineering agents, observe every workflow run, and ship code with
            the rigor of an instrument — not a gamble.
          </p>

          <dl className="fade-up stagger-3 grid grid-cols-3 gap-px overflow-hidden border border-ink-600 bg-ink-600/40">
            {[
              { label: 'active runs', tone: 'ember', value: '∞' },
              { label: 'agents', tone: 'paper', value: '12' },
              { label: 'uptime', tone: 'moss', value: '99.9%' },
            ].map((s) => (
              <div className="bg-ink-950 px-5 py-5" key={s.label}>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">
                  {s.label}
                </div>
                <div
                  className={`tabular mt-2 font-display text-3xl font-light leading-none ${
                    s.tone === 'ember'
                      ? 'text-ember-400'
                      : s.tone === 'moss'
                        ? 'text-moss-400'
                        : 'text-paper-100'
                  }`}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </dl>
        </div>

        <footer className="relative z-10 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          <span>© {new Date().getFullYear()} · workshop</span>
          <span>secured by hmac · jwt rotation enabled</span>
        </footer>
      </aside>

      {/* RIGHT: form panel */}
      <section className="relative flex items-center justify-center bg-ink-900 px-6 py-12 lg:px-16">
        <div className="w-full max-w-sm">
          {/* Mobile wordmark */}
          <div className="mb-10 flex items-baseline gap-1.5 lg:hidden">
            <span className="font-display text-2xl font-medium leading-none tracking-tight text-paper-50">
              auto
            </span>
            <span className="display-italic text-2xl leading-none text-ember-400">·swe</span>
          </div>

          <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.24em] text-ember-400">
            ¶ § auth/01
          </div>
          <h1 className="mb-2 font-display text-4xl font-light tracking-tight text-paper-50">
            Resume your session
          </h1>
          <p className="mb-10 text-sm text-paper-400">Authenticate to enter the control plane.</p>

          <form className="space-y-5" onSubmit={handleSubmit}>
            {error && (
              <div className="rounded-sm border border-brick-400/40 bg-brick-400/10 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-brick-400">
                ! {error}
              </div>
            )}
            <Input
              autoComplete="email"
              label="Email"
              name="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@workshop.dev"
              required
              type="email"
              value={email}
            />
            <Input
              autoComplete="current-password"
              label="Password"
              name="password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              required
              type="password"
              value={password}
            />
            <Button className="w-full" disabled={loading} size="lg" type="submit" variant="primary">
              {loading ? 'Authenticating…' : 'Enter →'}
            </Button>
          </form>

          {/* Divider */}
          <div className="my-8 flex items-center gap-4">
            <span className="h-px flex-1 bg-ink-600" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
              or
            </span>
            <span className="h-px flex-1 bg-ink-600" />
          </div>

          <a
            className="group flex w-full items-center justify-center gap-2 rounded-sm border border-ink-500 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-paper-300 transition-colors hover:border-ember-400 hover:text-ember-400"
            href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080'}/api/v1/auth/slack/connect`}
          >
            <span>continue with slack</span>
            <span className="transition-transform group-hover:translate-x-0.5">↗</span>
          </a>

          <p className="mt-10 font-mono text-[10px] uppercase tracking-[0.18em] text-paper-600">
            Forgot your password? Reach an admin to reset.
          </p>
        </div>
      </section>
    </div>
  );
}
