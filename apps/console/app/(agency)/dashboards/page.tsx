import { redirect } from 'next/navigation';

/** Dashboards are called Projects on the agency console now; old links and bookmarks land there. */
export default function Page() {
  redirect('/projects');
}
