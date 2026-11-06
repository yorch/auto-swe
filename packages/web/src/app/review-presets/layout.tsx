import { RoleLayout } from '@/components/auth/RoleLayout';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <RoleLayout allowed={['LEAD', 'ADMIN']}>{children}</RoleLayout>;
}
