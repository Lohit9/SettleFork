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
- [ ] Replace `supabase.auth.admin.listUsers({ perPage: 1000 })` 
      pattern with `findAuthUserByEmail` helper across 5 call sites. 
      Has a silent correctness ceiling at 1000 users. 
      (Scheduled: 2026-04-20, separate PR before SSO Prompt A)
- [ ] Remove dead code: `createOrganization` function in 
      `lib/actions/organizations.ts:42-73` and stale comment in 
      `lib/actions/auth.ts:133`. 
      (Scheduled: 2026-04-20)
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
  - Cobalt: contact form submitted; demo scheduled 2026-04-21.
  - Include Security: email delivered 2026-04-19; follow up via 
    contact form Thursday 2026-04-24 if no reply.
  - Doyensec: email sent 2026-04-19; awaiting response.
