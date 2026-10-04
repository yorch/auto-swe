import { redirect } from 'next/navigation';

// Budget alerts are the "Alerting only" filter on Organizations now.
export default function BudgetAlertsRedirect() {
  redirect('/govern/organizations?alerting=1');
}
