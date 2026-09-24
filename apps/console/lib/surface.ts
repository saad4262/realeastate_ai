import { headers } from 'next/headers';

export type ConsoleSurface = 'agent' | 'agency';

/**
 * Which console this request is for.
 *
 * Middleware resolves it from the host and passes it down as a header —
 * non-negotiable #12: never hardcode a surface, and never read the hostname
 * again further in.
 */
export async function currentSurface(): Promise<ConsoleSurface> {
  return (await headers()).get('x-console-surface') === 'agent' ? 'agent' : 'agency';
}

export type SurfaceCopy = {
  surface: ConsoleSurface;
  /** Where a signed-in member of this surface belongs. */
  home: string;
  productName: string;
  signInTitle: string;
  signInSubtitle: string;
  emailLabel: string;
  signUpTitle: string;
  signUpSubtitle: string;
  resetSubtitle: string;
  /**
   * Agencies self-register; agents cannot. An agent only ever arrives through
   * an invite link, so offering "Register an Agency" on the agent host sent
   * them off to create a second agency of their own.
   */
  selfRegisters: boolean;
  noAccountHint: string;
};

const AGENCY: SurfaceCopy = {
  surface: 'agency',
  home: '/overview',
  productName: 'Agency OS',
  signInTitle: 'Sign in to Agency OS',
  signInSubtitle: 'Enter your agency email and password to access your account.',
  emailLabel: 'Agency email',
  signUpTitle: 'Create your Agency OS account',
  signUpSubtitle: 'Use your agency email and a password to get started.',
  resetSubtitle: 'Recover access to your agency console by email.',
  selfRegisters: true,
  noAccountHint: 'Register an Agency',
};

const AGENT: SurfaceCopy = {
  surface: 'agent',
  home: '/listings',
  productName: 'Agent Desk',
  signInTitle: 'Sign in to your agent desk',
  signInSubtitle: 'Enter the email your agency invited, and your password.',
  emailLabel: 'Your email',
  signUpTitle: 'Set up your agent account',
  signUpSubtitle: 'Open the invite link your agency sent you to finish setting up.',
  resetSubtitle: 'Recover access to your agent desk by email.',
  selfRegisters: false,
  noAccountHint: 'Agents join by invitation — ask your agency to send you a link.',
};

export function copyFor(surface: ConsoleSurface): SurfaceCopy {
  return surface === 'agent' ? AGENT : AGENCY;
}

export async function surfaceCopy(): Promise<SurfaceCopy> {
  return copyFor(await currentSurface());
}
