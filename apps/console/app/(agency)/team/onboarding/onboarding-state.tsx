'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  TIER_SPLITS,
  type InviteAgentDraft,
  type OperationalRole,
} from '@repo/core/team/schema';

const STORAGE_KEY = 'lah.agent-onboarding.v1';

export type OnboardingState = InviteAgentDraft;

const DEFAULT_STATE: OnboardingState = {
  firstName: '',
  lastName: '',
  displayName: '',
  email: '',
  phone: '',
  licenceNumber: '',
  licenceClass: 'Class 1',
  licenceExpiry: null,
  // Left blank on purpose: these used to be pre-filled with demo values, so
  // every new agent arrived with a Bondi Beach territory nobody chose.
  territorySuburbs: [],
  territoryRadiusKm: 8,
  specialties: [],
  languages: ['en'],
  commissionTier: 't1',
  commissionSplitAgent: 70,
  commissionSplitAgency: 30,
  operationalRole: 'senior',
  permissionFlags: {
    listings: true,
    trust: true,
    crm: true,
    mkt: true,
    fido: true,
  },
  photoUrl: null,
  bio: null,
};

type Ctx = {
  draft: OnboardingState;
  hydrated: boolean;
  patch: (partial: Partial<OnboardingState>) => void;
  setOperationalRole: (role: OperationalRole) => void;
  setCommissionTier: (tier: 't1' | 't2' | 't3') => void;
  reset: () => void;
};

const OnboardingContext = createContext<Ctx | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<OnboardingState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        setDraft({ ...DEFAULT_STATE, ...JSON.parse(raw) });
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft, hydrated]);

  const patch = useCallback((partial: Partial<OnboardingState>) => {
    setDraft((prev) => {
      const next = { ...prev, ...partial };
      if (partial.firstName !== undefined || partial.lastName !== undefined) {
        const first = partial.firstName ?? prev.firstName;
        const last = partial.lastName ?? prev.lastName;
        if (!prev.displayName || prev.displayName === `${prev.firstName} ${prev.lastName}`.trim()) {
          next.displayName = `${first} ${last}`.trim();
        }
      }
      return next;
    });
  }, []);

  const setOperationalRole = useCallback((role: OperationalRole) => {
    setDraft((prev) => ({ ...prev, operationalRole: role }));
  }, []);

  const setCommissionTier = useCallback((tier: 't1' | 't2' | 't3') => {
    const splits = TIER_SPLITS[tier];
    setDraft((prev) => ({
      ...prev,
      commissionTier: tier,
      commissionSplitAgent: splits.agent,
      commissionSplitAgency: splits.agency,
    }));
  }, []);

  const reset = useCallback(() => {
    setDraft(DEFAULT_STATE);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  const value = useMemo(
    () => ({
      draft,
      hydrated,
      patch,
      setOperationalRole,
      setCommissionTier,
      reset,
    }),
    [draft, hydrated, patch, setOperationalRole, setCommissionTier, reset],
  );

  return (
    <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return ctx;
}
