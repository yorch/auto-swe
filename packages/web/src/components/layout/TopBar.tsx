'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { useInbox, useTeams } from '@/hooks/useWorkflows';
import { useAuthStore } from '@/stores/authStore';
import { useTeamStore } from '@/stores/teamStore';

export function TopBar() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const { selectedTeamId, setSelectedTeamId } = useTeamStore();
  const { data: teams } = useTeams();

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const teamLabel = teams?.find((t) => t.id === selectedTeamId)?.name ?? 'all teams';
  const { data: inboxSteps } = useInbox();
  const inboxCount = (inboxSteps ?? []).length;
  const isAdmin = user?.role === 'ADMIN';

  return (
    <header
      className="flex items-center justify-between border-b border-ink-600/60 px-6"
      style={{ background: 'var(--color-ink-900)', height: '46px' }}
    >
      <div className="flex items-center gap-4">
        {/* Online status */}
        <div className="flex items-center gap-2">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-moss-400" />
          <span
            className="text-paper-500"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10.5px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}
          >
            online
          </span>
        </div>

        <span className="h-3.5 w-px bg-ink-500" />

        {/* Team context selector */}
        <label
          className="relative flex items-center gap-1.5 cursor-pointer"
          htmlFor="topbar-team-select"
        >
          <span
            className="text-paper-500"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '10.5px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}
          >
            context
          </span>
          <span
            className="text-paper-500"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
          >
            [
          </span>
          <span
            className="flex items-center gap-1 text-paper-300"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
          >
            team:
            <span className="text-ember-400">{teamLabel}</span>
            <Select
              aria-label="Select team"
              className="absolute inset-0 cursor-pointer opacity-0"
              id="topbar-team-select"
              onChange={(e) => setSelectedTeamId(e.target.value || null)}
              value={selectedTeamId ?? ''}
            >
              <option value="">all teams</option>
              {(teams ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <span className="text-paper-500">▾</span>
          </span>
          <span
            className="text-paper-500"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
          >
            ]
          </span>
        </label>

        {inboxCount > 0 && (
          <>
            <span className="h-3.5 w-px bg-ink-500" />
            <Link
              className="flex items-center gap-1.5 text-amber-400 hover:text-amber-300 transition-colors"
              href="/inbox"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10.5px',
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
              }}
            >
              inbox
              <span
                className="bg-amber-400 text-ink-950 rounded-full leading-5 px-1.5 font-bold"
                style={{ fontSize: '9px' }}
              >
                {inboxCount}
              </span>
            </Link>
          </>
        )}
      </div>

      <div className="flex items-center gap-4">
        {isAdmin && (
          <>
            <Link
              className="text-paper-500 hover:text-paper-300 transition-colors"
              href="/admin/model-config"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10.5px',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
              }}
            >
              Admin
            </Link>
            <span className="h-3.5 w-px bg-ink-500" />
          </>
        )}
        <button
          className="flex items-center gap-1 text-paper-500 hover:text-ember-400 transition-colors"
          onClick={handleLogout}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10.5px',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}
          type="button"
        >
          Logout
          <span className="text-xs">↗</span>
        </button>
      </div>
    </header>
  );
}
