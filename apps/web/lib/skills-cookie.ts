/**
 * The cookie the Skills page keeps: the consumer skills this browser's buyer switched off (ADR 0080). Read by
 * HideIfSkillOff on cached, sessionless pages. Display only — never trusted; every skill's own page and the
 * chat check the real switch in the database.
 */
export const SKILLS_OFF_COOKIE = 'skills_off';
