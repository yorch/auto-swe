'use client';

import { useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { useTeams } from '@/hooks/useWorkflows';
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

  return (
    <header className="flex h-14 items-center justify-between border-b border-ink-600 bg-ink-950/40 px-8 backdrop-blur-sm">
      <div className="flex items-center gap-5">
        {/* Status indicator */}
        <div className="flex items-center gap-2">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-moss-400" />
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
            online
          </span>
        </div>

        <span className="h-4 w-px bg-ink-500" />

        {/* Team picker — styled as a terminal context */}
        <label className="group relative flex items-center gap-2" htmlFor="topbar-team-select">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
            context
          </span>
          <span className="font-mono text-xs text-paper-400">[</span>
          <span className="flex items-center gap-1 font-mono text-xs text-paper-100">
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
          <span className="font-mono text-xs text-paper-400">]</span>
        </label>
      </div>

      <div className="flex items-center gap-5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
          {user?.role ?? 'guest'}
        </span>
        <span className="h-4 w-px bg-ink-500" />
        <button
          className="group inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-paper-400 transition-colors hover:text-ember-400"
          onClick={handleLogout}
          type="button"
        >
          <span>logout</span>
          <span className="transition-transform group-hover:translate-x-0.5">↗</span>
        </button>
      </div>
    </header>
  );
}
