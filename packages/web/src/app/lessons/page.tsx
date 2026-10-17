import { redirect } from 'next/navigation';

/** The old lessons URL. The Lessons page is open to every role, scoped to the caller's repositories. */
export default function LessonsRedirect() {
  redirect('/admin/lessons');
}
