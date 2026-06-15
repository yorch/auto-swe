import { redirect } from 'next/navigation';

// The role-based agents page was replaced by the first-class Agent library
// (P1.5 — the legacy AgentSkillAssignment/AgentToolConfig routes are gone).
export default function AdminAgentsPage() {
  redirect('/admin/agents/library');
}
