import Link from 'next/link';
import { can } from '@repo/core/permissions';
import contactStyles from '@/components/contacts/contacts.module.css';
import { NewLibrarySkillForm } from '@/components/skills/islands';
import { requireConsoleAccess } from '../../../../../lib/require-console-access';

/** Add a skill to the agency's own library — owners and admins (skill:curate). */
export default async function Page() {
  const session = await requireConsoleAccess('agency');
  if (!can(session.actor, 'skill:curate', { type: 'skill', agencyId: session.actor.agencyId })) {
    return <p role="alert" style={{ padding: '1rem', color: 'var(--rose)' }}>Only an owner or admin adds library skills.</p>;
  }
  return (
    <div className={contactStyles.wrap}>
      <Link href="/skills" className={contactStyles.back}>← Skills</Link>
      <div className={contactStyles.headText}>
        <h1 className={contactStyles.title}>New library skill</h1>
        <p className={contactStyles.sub}>Your agency&apos;s own version of a skill: same job, your words. Agents add it from the library.</p>
      </div>
      <div className={contactStyles.card}>
        <NewLibrarySkillForm basePath="/skills" />
      </div>
    </div>
  );
}
