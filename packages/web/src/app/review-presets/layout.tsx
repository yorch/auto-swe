import { AccessLayout } from '@/components/auth/AccessLayout';

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AccessLayout access="any">{children}</AccessLayout>;
}
