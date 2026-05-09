'use client';

import { useRouter } from 'next/navigation';
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

  return (
    <header className="h-14 border-b border-[var(--border)] bg-white flex items-center justify-between px-6">
      <div className="flex items-center gap-4">
        <select
          className="text-sm border border-[var(--border)] rounded-md px-2 py-1"
          onChange={(e) => setSelectedTeamId(e.target.value || null)}
          value={selectedTeamId ?? ''}
        >
          <option value="">All Teams</option>
          {(teams ?? []).map((t: any) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-[var(--muted-foreground)]">{user?.role}</span>
        <button
          className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          onClick={handleLogout}
          type="button"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
