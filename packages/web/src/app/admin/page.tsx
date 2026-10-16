'use client';

import Link from 'next/link';
import { useAdminPages } from '@/components/layout/AdminNav';
import { Card } from '@/components/ui/Card';
import { Icon, isIconName } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { ADMIN_HREF, navLabel, navSections } from '@/lib/navigation';
import { cn, FOCUS_RING } from '@/lib/utils';

/** The Admin area's landing page: every Admin page the user may open, by section. */
export default function AdminOverviewPage() {
  const pages = useAdminPages();

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="People and access, security, spend, platform configuration, integrations and what the agents have learned. What is listed depends on your role."
        title={navLabel(ADMIN_HREF)}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {navSections(pages).map((section) => (
          <Card className="p-4" key={section.label ?? ''}>
            {section.label && (
              <h2 className="mb-2 text-sm font-semibold text-paper-100">{section.label}</h2>
            )}
            <ul className="space-y-px">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    className={cn(
                      '-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-paper-300 no-underline transition-colors hover:bg-ink-600 hover:text-paper-100',
                      FOCUS_RING
                    )}
                    href={item.href}
                  >
                    <Icon
                      className="text-paper-500"
                      name={isIconName(item.icon) ? item.icon : 'dashboard'}
                      size={15}
                    />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
