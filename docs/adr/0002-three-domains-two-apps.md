# ADR 0002 — Three domains, two apps

## Context
The client wants three websites: consumer, agent, and agency. Separate codebases multiply auth, nav, and bugfix drift. AU principals often act as lead agents on listings.

## Decision
Ship **three domains / two Next.js apps**: `apps/web` for the public site; `apps/console` for both `agents.*` and `agency.*`, host-routed into `(agent)` and `(agency)` route groups. Shared logic lives in `packages/`.

## Alternatives
- Three apps — rejected for now: reversible later (2→3 is cheap; 3→2 is not).
- One app for everything — rejected: SEO/ISR vs session-heavy console have conflicting deploy needs.

## Consequences
Never fork agent vs agency into separate apps without the split triggers in architecture.md. Surface comes from middleware. White-label per agency is an open client decision before M0 locks routing.
