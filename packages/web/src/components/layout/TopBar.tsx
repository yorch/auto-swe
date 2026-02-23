'use client';

import { useAuthStore } from '@/stores/authStore';
import { useTeamStore } from '@/stores/teamStore';
import { useTeams } from '@/hooks/useWorkflows';
import { useRouter } from 'next/navigation';

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
          value={selectedTeamId ?? ''}
          onChange={(e) => setSelectedTeamId(e.target.value || null)}
          className="text-sm border border-[var(--border)] rounded-md px-2 py-1"
        >
          <option value="">All Teams</option>
          {(teams ?? []).map((t: any) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-[var(--muted-foreground)]">{user?.role}</span>
        <button
          onClick={handleLogout}
          className="text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
