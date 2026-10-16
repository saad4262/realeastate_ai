import { redirect } from 'next/navigation';

/** Dashboards are called Projects on the agent desk now; old links and bookmarks land there. */
export default function Page() {
  redirect('/my-projects');
}
