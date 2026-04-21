# Outstanding Items

This document tracks known issues, deferred work, and items flagged 
during reviews that we intend to address. It is the authoritative 
backlog for engineering, security, and operational items not yet 
tracked in a formal ticket system.

Items graduate off this list when:
- Shipped (delete the line, or move to a CHANGELOG)
- Moved to a formal ticket (link from here to there)
- Explicitly decided to not do (move to "Rejected" section with reason)

Last updated: 2026-04-20

---

## Engineering — Tier 1 (near-term)

### Security
- [ ] SSO epic — Prompt A (migration, types, admin API surface, 
      bookmark app endpoint). (Scheduled: 2026-04-20)
- [ ] SSO epic — Prompt B (middleware + login + callback with 
      dedupe-on-login). (Scheduled: 2026-04-21)
- [ ] SSO epic — Prompt C (invite flow + identity linking). 
      (Scheduled: 2026-04-22)
- [ ] SSO epic — Prompt D (admin UI, customer-facing + platform-admin). 
      (Scheduled: 2026-04-23)

### Planned near-term (Tier 1)
- [ ] Audit log expansion (auth events, invites, exports, admin actions). 
      Item 1.B from security plan.
- [ ] Production rate limiting via Upstash Redis. Item 1.E.
- [ ] DPA draft. Item 1.G.
- [ ] Subprocessors page. Item 1.H.
- [ ] Per-org IP allowlisting (middleware-enforced). Item 1.I.
- [ ] Data residency documentation. Item 1.J.
- [ ] Configure ESLint for the project. Currently no `.eslintrc.*` 
      file exists; CI would have no style enforcement beyond `tsc`. 
      Add `@typescript-eslint/recommended` + `next/core-web-vitals` + 
      a minimal prettier config. Low urgency but should be in place 
      before the pen test engagement (May 12) since vendors often 
      check for linting hygiene as a code-quality signal.
- [ ] Replace the `'none'` sentinel pattern in `createOrgInvite` 
      (`lib/actions/org-invites.ts`, preserved in Commit 3.2 of the 
      listUsers refactor). Currently `.eq('user_id', 
      existingAuthUser?.id ?? 'none')` relies on a UUID-cast error to 
      silently return no match. Should be replaced with an explicit 
      early-return or `if (existingAuthUser) { ... }` gate. Low 
      urgency, low risk, but removes a latent foot-gun. Defer until 
      after Commit 3.3 ships so the git history of the listUsers 
      refactor stays clean.

### Planned Tier 2
- [ ] MFA enforcement policy (grace period, recovery codes).
- [ ] RBAC refinement (granular permissions per resource).
- [ ] Encryption key rotation program for DB connector credentials.
- [ ] GDPR data deletion path (cascading deletes, retention carve-outs).
- [ ] ISMS policy documentation (security, access control, incident 
      response, acceptable use, data classification, change management).
- [ ] DR/BCP documentation (RTO/RPO, restore tests, failover).
- [ ] Vulnerability management program + CI-integrated dependency 
      scanning.

### Planned Tier 3
- [ ] SCIM provisioning (per SCIM epic, layered on SSO).
- [ ] Customer-managed encryption keys (CMEK via KMS envelope 
      encryption).

---

## Backlog — Lower priority

### SSO-related (customer-triggered)
- [ ] Single Logout (SLO) support — SAML SLO + IdP session binding. 
      Build when a customer asks.
- [ ] Self-service SSO configuration UI for org admins. Build at 5-10 
      customers or before Series A.
- [ ] Session invalidation on SCIM deactivate. Part of SCIM epic.
- [ ] Configurable session lifetime per org. Customer-triggered.
- [ ] Encrypted SAML assertions. Customer-triggered.
- [ ] Periodic forced re-auth. Customer-triggered.
- [ ] Per-org user email allowlist for JIT provisioning. Customer-
      triggered (4-hour feature).
- [ ] Read-only `public.sso_providers` mirror table for debuggability.

### Scope-deferred
- [ ] Organization deletion / data export flow (part of GDPR work).
- [ ] OIDC support (SAML-only at launch; add if customer asks).

---

## Known issues (not yet triaged)
_(Items land here when discovered but not yet decided on. Graduate 
to "Planned" or "Rejected" once a decision is made.)_

---

## Rejected (with reason)
- [x] BYOC (Bring Your Own Cloud) — not planned for this product. 
      Revisit at Series A+ with customer demand.
- [x] FedRAMP readiness — 6-12 months and $500K-$2M cost; not viable 
      pre-Series A.
- [x] HIPAA readiness — not selling to healthcare verticals at this 
      stage.

---

## Process notes

- Cyber insurance (separate track, user-handled): Coalition / At-Bay / 
  Corvus, $3-10K/year.
- SOC 2 Type 1 + 2: both kick off post-pre-seed.
- Anthropic zero-retention email sent 2026-04-19, awaiting response 
  (follow up 2026-04-27 if no reply).
- Pen test vendor outreach in flight:
  - Cobalt: demo rescheduled to 2026-04-21 (tomorrow). Prep doc 
    prepared; will debrief post-call.
  - Include Security: email delivered 2026-04-19; no response yet. 
    Follow up via contact form if no reply by Thursday 2026-04-24.
  - Doyensec: email sent 2026-04-19 with updated tier commitment 
    scope; awaiting response.
  - Latacora: skipped (business model mismatch — they sell retained 
    security teams, not one-off pen tests).
  - 4th vendor: decided to skip after Cobalt demo was booked.
- GitHub repo renamed from `kaandincer/mine` → `kaandincer/settle` on 
  2026-04-20 to align with product rebrand. Local remote updated same 
  day. Old URL still redirects temporarily; reliance on redirect 
  deprecated.

---

## Completed

- [x] 2026-04-20 — Removed dead code: `createOrganization` function in 
      `lib/actions/organizations.ts` (unreachable since commit b752919, 
      all call sites migrated to `adminCreateOrganization` or inlined 
      `supabaseAdmin` inserts) + stale comment cleanup in 
      `lib/actions/auth.ts:133`. Commit: 5b1b89c.
- [x] 2026-04-20 — Rebased dev onto main to pull in OutputsContent 
      hotfix (commit b1c3c21). Dev is now a strict superset of main; 
      future dev→main merges will be clean fast-forwards.
- [x] 2026-04-20 — Migration 069: created `find_auth_user_by_email` + 
      `get_auth_emails_by_ids` SECURITY DEFINER RPCs. Applied to 
      production Supabase. Commit: 89a520b (now 89a520b post-rebase).
- [x] 2026-04-20 — Added `lib/auth/users.ts` helper module 
      (`findAuthUserByEmail`, `authUserExistsByEmail`, 
      `getAuthEmailsByIds`). Commit: 0bf0873.
- [x] 2026-04-20 — Commit 3.1 of listUsers refactor: replaced 
      `listUsers` scan in `getOrgMembers` + `adminGetOrgMembers` 
      (`lib/actions/organizations.ts`) with `getAuthEmailsByIds`. 
      Commit: 9f542f5.
- [x] 2026-04-20 — Completed listUsers refactor: all 5 call sites 
      migrated to SECURITY DEFINER RPC-backed helpers from 
      `lib/auth/users.ts`. Commits: 9f542f5 (org member listings), 
      <commit-3.2-hash> (invite creation pre-check), 
      <commit-3.3-hash> (public invite page). Silent correctness 
      ceiling at 1000 users eliminated; all `auth.users` access now 
      flows through 3 named, audited RPCs with EXECUTE granted only 
      to `service_role`.
