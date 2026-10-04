import { redirect } from 'next/navigation';

// Agent runs are started from Start work; this address is kept for old links.
export default function AgentRunsPage() {
  redirect('/start?mode=agent');
}
