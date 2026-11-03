'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { SKILLS_OFF_COOKIE } from '../lib/skills-cookie';

/**
 * Hides a consumer skill's panel on a cached, sessionless page (the listing) when this browser's buyer
 * switched the skill off (ADR 0080). The server cannot ask on that page — it has no session by design
 * (ARCHITECTURE § 9) — so the Skills page mirrors the switch into a cookie and this reads it. A courtesy,
 * not a gate: the panel is public arithmetic, and the skill's own page checks the real switch.
 */
export function HideIfSkillOff({ skill, children }: { skill: string; children: ReactNode }) {
  const [off, setOff] = useState(false);
  useEffect(() => {
    const raw = document.cookie.split('; ').find((c) => c.startsWith(`${SKILLS_OFF_COOKIE}=`));
    setOff(Boolean(raw && decodeURIComponent(raw.slice(SKILLS_OFF_COOKIE.length + 1)).split(',').includes(skill)));
  }, [skill]);
  return off ? null : <>{children}</>;
}
