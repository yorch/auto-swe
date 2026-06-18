import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SkillOption {
  id: string;
  name: string;
  description: string | null;
  isBuiltIn: boolean;
}

export function useSkills() {
  return useQuery({
    queryFn: () =>
      api.get<{ data: SkillOption[] }>('/api/v1/admin/skills').then((r) => r.data),
    queryKey: ['admin-skills'],
  });
}
