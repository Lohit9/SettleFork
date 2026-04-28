# Outstanding Items

This document tracks known issues, deferred work, and items flagged 
during reviews that we intend to address. It is the authoritative 
backlog for engineering, security, product, and operational items not 
yet tracked in a formal ticket system.

Items graduate off this list when:
- Shipped (delete the line, or move to the Completed section)
- Moved to a formal ticket (link from here to there)
- Explicitly decided to not do (move to "Rejected" section with reason)

Last updated: 2026-04-28

---

## Engineering — Tier 1 (near-term, pilot-blocking)

### Security
- [ ] SSO epic — Prompt B (middleware + login + callback with 
      dedupe-on-login). (Scheduled: 2026-04-21)
    - **✓ COMPLETE — B-2-a (rate limiting + callback hardening).** 
      Both halves shipped on branch `feat/sso-okta-setup`.
        - **B-2-a-i (rate limiter): commit `3dacb92`.**
          - Upstash Redis sliding-window limiter at 
            `lib/rate-limit/upstash.ts` (10/min, prevents 
            59s/61s burst-bypass that fixed-window allows).
          - Wired into `/sso/start` (per-IP+org_slug) and 
            `checkSSOEnabledForEmail` (per-IP+email_domain_hash), 
            10/min each. Composite keys prevent per-IP-only 
            exhaustion (shared NAT) and per-target-only 
            exhaustion (single attacker draining one org).
          - Canonical IP extractor at `lib/auth/get-client-ip.ts` 
            (null-on-miss, fail-closed — does NOT replicate 
            `lib/actions/auth.ts`'s `'127.0.0.1'` fallback that 
            collides anonymous traffic into one bucket).
          - Defense-in-depth: narrowed 
            `checkSSOEnabledForEmail` return shape from 
            `{ required, orgId?, orgSlug?, providerId?, 
            enforcementMode? }` to `{ required, orgSlug? }`. 
            Removes unauthenticated leak of internal `org_id`, 
            `sso_providers.id`, and `enforcement_mode`.
          - Audit folded into existing `sso.login.failure` 
            event_type with `metadata.reason='rate_limited'` (no 
            migration needed — symmetric with B-2-a-ii's 7 new 
            reason values).
        - **B-2-a-ii (callback hardening): commit `e9c217d`.**
          - Six ordered security checks before authenticating: 
            HMAC attempt-cookie verify, provider resolution from 
            session, cross-tenant, domain-provider sanity, 
            duplicate account (same-user via 
            `get_auth_identity_providers`), JIT via 
            `provision_user_via_jit`.
          - Identity linking via `mark_identity_sso_linked` is 
            non-blocking (failures audited but login proceeds — 
            middleware-side repair for unlinked SSO sessions 
            deferred as future work).
          - HMAC-signed attempt cookie via 
            `SSO_ATTEMPT_COOKIE_SECRET` env var (new module 
            `lib/sso/attempt-cookie.ts`).
          - Cross-user duplicate detection RPC deferred per 
            Decision D7 (same-user check sufficient for current 
            Supabase 1:1 email invariant).
        - **Out of scope (tracked separately):** existing 
          in-memory rate limiters at 
          `lib/auth/signup-rate-limit.ts` and 
          `lib/ai/rate-limit.ts` deliberately left unmigrated; 
          tracked as 8-week-plan Item 4.2.
    - **✓ COMPLETE — B-2-b (login page redesign with email-first 
      SSO discovery).** Two-stage form replaces the legacy 
      single-stage email+password layout. Stage 1 collects email 
      and probes `checkSSOEnabledForEmail`; Stage 2 renders 
      password (always) and a "Continue with single sign-on" 
      button (hybrid orgs). Strict-SSO orgs are redirected to 
      `/sso/start` directly from Stage 1.
        - New canonical helpers: `lib/auth/safe-next.ts` 
          (consolidates open-redirect / CRLF rules used by both 
          login and `/sso/start`) and 
          `lib/auth/login-reason-codes.ts` (single source of 
          truth for the 14 `?reason=…` / `?error=…` codes 
          previously dropped silently on `/login`).
        - Source-level test 
          `tests/lib/auth/login-reason-codes-source.test.ts` 
          enforces bidirectional invariant: every emitted code 
          maps to copy, every code in the map is emitted. 
          Prevents future silent-drop regressions.
        - Re-broadened `checkSSOEnabledForEmail` to return 
          `orgSlug` for hybrid orgs in addition to strict (was 
          over-narrowed in B-2-a-i). `org_id`, 
          `sso_providers.id`, and `enforcement_mode` remain 
          hidden. Fail-closed paths still return 
          `{ required: false }` with no slug — rate-limit hit 
          remains indistinguishable from "no SSO".
        - Pre-existing bugs fixed in `EmailFirstLoginForm`: 
          `?returnTo=` now read alongside `?redirect=`; 
          `//evil.com` open-redirect blocked; catch-block now 
          resets `loading` state.
        - Browser-autofill compat via hidden 
          `<input type=password>` on Stage 1 (sr-only + 
          tabIndex=-1 + aria-hidden).
        - Feature flag `NEXT_PUBLIC_LOGIN_EMAIL_FIRST` (defaults 
          to enabled). Setting to `'false'` selects the legacy 
          single-stage form preserved at 
          `components/auth/LegacyLoginForm.tsx` for instant 
          rollback. **Removal plan:** delete legacy component + 
          flag after 14 days of prod stability.
        - Test coverage: 49 component tests covering both stages, 
          all 14 reason-code banners, redirect/returnTo 
          preservation, probe fail-soft, double-submit guards.
- [ ] SSO epic — Prompt C (invite flow + identity linking). 
      (Scheduled: 2026-04-22)
- [ ] SSO epic — Prompt D (admin UI, customer-facing + platform-admin). 
      (Scheduled: 2026-04-23)

### Planned near-term (Tier 1)
- [ ] Audit log expansion (auth events, invites, exports, admin actions, 
      SSO events — SSO login/JIT provisioning/enforcement mode change/
      domain allowlist change). Item 1.B from security plan.
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
      urgency, low risk, but removes a latent foot-gun.

### Planned Tier 2
- [ ] MFA enforcement policy (grace period, recovery codes).
- [ ] RBAC refinement (granular permissions per resource).
- [ ] Encryption key rotation program for DB connector credentials.
- [ ] GDPR data deletion path (cascading deletes, retention carve-outs).
- [ ] Tighten `project_members` SELECT RLS policy. Current policy 
      (`org_members_can_view_project_members`, 050:255-256) allows 
      any user with project access to see all other project 
      members. When cross-org guest access is enabled (future 
      feature), this becomes a cross-tenant information leak — 
      external guests would see full employee directory of the 
      hosting org for any shared project. Mitigation: SECURITY 
      DEFINER helper that returns the full list for org members 
      but restricts external guests to seeing only their own row + 
      project admin info. Not urgent today (no code path exercises 
      the cross-org case) but should ship before guest access UX. 
      Flag for pen test scope documentation.
- [ ] ISMS policy documentation (security, access control, incident 
      response, acceptable use, data classification, change management).
- [ ] DR/BCP documentation (RTO/RPO, restore tests, failover).
- [ ] Vulnerability management program + CI-integrated dependency 
      scanning.
- [ ] Switch to AWS from Supabase, OR enable server-side inactivity 
      timeout on Supabase Auth. Decision point: evaluate infra 
      migration cost vs. Supabase feature adequacy when enterprise 
      security requirements escalate.

### Planned Tier 3
- [ ] SCIM provisioning (per SCIM epic, layered on SSO).
- [ ] Customer-managed encryption keys (CMEK via KMS envelope 
      encryption).

---

## Sprint pipeline (product work, post-security-baseline)

Sprint cadence is 1-2 weeks. Items marked "scope-dependent" are 
weeks of work on their own and may slip into a later sprint if 
other priorities emerge.

### Sprint 6 — Additional security & privacy (current sprint)
Tracks alongside the Tier 1 security epic above.
- [ ] SSO (SAML 2.0 / OIDC) — SAML 2.0 launching first; OIDC 
      backlog.
- [ ] IP allowlisting — per-org, middleware-enforced.
- [ ] Switch to AWS from Supabase, OR enable server-side inactivity 
      timeout as additional layer on Supabase Auth.
- [ ] SCIM provisioning (auto user sync from identity providers).
- [ ] SOC 2 compliance certification (kicks off post-pre-seed).
- [ ] BYOC & on-prem deployment — currently Rejected; revisit at 
      Series A+ with customer demand.

### Sprint 7 — AI improvements
- [ ] Fine-tuned and trained models for specific actions. 
      **Scope-dependent** — requires training infrastructure, 
      labeled data pipeline, fine-tuning budget, and evaluation 
      harness. Likely multi-sprint effort.
- [ ] Migration Intelligence Graph — self-improving account-level 
      learning. **Scope-dependent** — requires schema for learning 
      state, retrieval logic, ranking, and UI surfacing. Likely 
      multi-sprint effort.
- [ ] MCP integration — define how Settle integrates with Model 
      Context Protocol.
- [ ] Transform iteration — pass existing SQL into Claude for 
      refinement rather than regeneration.
- [ ] Unified Schema Formatter.
- [ ] Claude to be more explicit about why it changed the query 
      (e.g., when user's question doesn't match data types, return 
      a helpful query showing actual values with SQL comment 
      explaining why).

### Sprint 8 — Exports & integrations
- [ ] Integration exports (dbt, Informatica, Azure Data Factory, 
      Airflow DAGs, AWS Glue) — priority order per `docs/
      etl-architecture.md`.
- [ ] Snowflake connector — potential differentiator for Mitratech 
      specifically; they may use Snowflake as staging.

### Sprint 9 — Refinements & UX
- [ ] UI & UX redesign — merge Mapping & Transformation pages 
      (open design questions — see below).
- [ ] Ability to only change/regenerate a single file in the 
      execution package section.
- [ ] Refine T-SQL execution package date parsing (currently uses 
      `LIKE '%YYYY%'` fallback alongside `TRY_CAST`; works but 
      imprecise).
- [ ] Ability to delete an org from admin view.
- [ ] Tighten up multi-user project structure.
- [ ] Transformation version history.
- [ ] User Settings > Preferences: add back "Default confidence 
      threshold", "AI fix suggestions", "Email notifications".
- [ ] Filters for data preview columns.

---

## Known bugs & fixes (current)
- [ ] Show source issues in the Stage Data button (transform tab).
- [ ] Whenever we stage data, run an updated scan to detect any 
      fixes.
- [ ] SQL Query editor issues (scope TBD).
- [ ] Test whether a PDF schema doc can be ingested as a DDL script.
- [ ] Glitching of amber → green transition on hitting checkmarks.
- [ ] Clicking "Approve All" — unmapped fields have a lag in 
      updating.
- [ ] False positives on transform tab (says transform needed when 
      it does not).
- [ ] Clicking Apply stages the data but issues are not detected 
      immediately in Validate.
- [ ] Claude failed to create 1 of 8 ETL scripts in the right SQL 
      dialect; dialect validation failure stopped all 8 scripts 
      from being produced. Need graceful handling of partial 
      dialect failures.
- [ ] Excel extraction floating-point artifacts (e.g., 
      `22906.2099999999995`). Not blocking — Claude interprets 
      fine — but rounding to 2 decimal places at extraction time 
      would tighten it up.
- [ ] T-SQL date parsing precision (see Sprint 9 item for full 
      refactor).
- [ ] `project_members.role` column allows NULL (original 050:44 
      schema doesn't declare NOT NULL). `role-resolution.ts:21` has 
      a latent fall-through: NULL role short-circuits to 
      `org_memberships` fallback rather than treating the 
      `project_members` row as authoritative. Unintentional; almost 
      certainly bug. Fix: migration to add NOT NULL constraint 
      after auditing for any existing NULL rows.

---

## Testing tasks

Validation work deferred until a later stage has enough surface area 
to exercise it. Items here are not bugs — they are known-unknowns 
that need empirical confirmation.

### SSO (Prompt D or post-Prompt D)
- [ ] Validate GoTrue error response shapes against real API responses. 
      A2's defensive error parser handles unknown shapes by extracting 
      any available message fields, but the exact shape of each 
      failure mode (duplicate domain, malformed metadata, invalid 
      entity ID) is not empirically verified. Test during first real 
      IdP configuration in Prompt D or earlier if a vendor conversation 
      requires a live demo.
- [ ] Validate PKCE cookie persistence across `/sso/start` → IdP → 
      `/api/auth/callback` flow. SDK source analysis confirmed the 
      flow should work, but `@supabase/ssr` issue #55 documents a 
      known class of PKCE cookie bugs. Real test requires full SAML 
      round-trip; first real SSO login in Prompt D will surface any 
      issues. Symptom of failure: callback errors with "missing code 
      verifier."
- [ ] End-to-end SSO flow validation with real IdP. Okta developer 
      tenant recommended (free, quick setup). Alternatives: Azure AD 
      tenant, Google Workspace test domain. Test scope: configure 
      provider via `/admin/sso`, log in via SSO, verify session 
      cookie, verify `sso_identity_links` row created, verify 
      `sso.login.success` audit event emitted. Do during Prompt D 
      smoke testing.

---

## Open design questions

Design-level decisions that need to be made before certain work 
can begin. Decisions made here graduate into sprint items.

### Mapping/Transform UX redesign
- Field-to-field is the user's mental model (confirmed); not 
  table-to-table.
- Merge Mapping + Transform into one page? Split-view 50-50 
  drag-adjustable? Or keep as separate tabs with better navigation?
- Visual connector pattern (Figma / LucidChart-style) feasibility 
  at 1000-5000 fields.
- Replace field coverage progress bar with better metrics at the 
  top of page.
- Adopt side-drawer pattern from Data Quality tab for field 
  detail (replace current side popup).
- Full details and research in `docs/
  mapping-transform-ux-research.md`.

### Transform workflow (tabled 2026-03-31)
- Should transforms auto-save? Currently draft → saved → applied 
  status progression; is that friction or value?
- How does user revert a bad transform? Regenerate vs. version 
  history vs. undo buffer.
- Button naming: "Apply Transform" confusing — rename to "Save 
  Transform" or remove the button entirely.
- When does staging happen? Manual button vs. auto-stage on save 
  vs. auto-stage on tab navigate.
- Is "Test Transform" button adding value vs. collapsing into 
  preview toggle?
- Status badge progression — simplify to binary done/not-done or 
  keep multi-state?
- Recommended starting point: rename "Apply" → "Save", test in 
  demo, evaluate if further changes needed.

### Schema overview logic
- Decision needed: schema docs vs. schema overview vs. business 
  context docs — which drives what?
- Current direction: schema docs = baseline, user adjustments 
  override, business rules add additional constraints.
- Document this decision when refining the profiling tab.

### Refine what drives mapping, transformation, and validation logic
- Open decision on source-of-truth hierarchy for AI-driven logic. 
  Related to schema overview question above.

### ETL pipeline architecture
- Four approaches evaluated (Migration Execution Package / 
  Migration Template Library / Runbook Document / Integration 
  Exports).
- Decision: Execution Package first (shipped), Template Library 
  post-funding, Integration Exports in Sprint 8, Runbook 
  Document as ongoing enhancement.
- Full analysis in `docs/etl-architecture.md`.

### UI refinements — Mapping tab
- Clearer visual indicator for approved or rejected mappings?
- Do we want to show sample values in the profiling tab?

---

## Performance refinements (known issues, scoped)

- [ ] N+1 loop in `computeReadinessScore` — 1 function, ~10-line 
      fix, very low risk. Highest ROI perf win in the codebase.
- [ ] Duplicate auth + project fetches — every page re-verifies 
      auth and fetches project that layout already fetched. 4 
      wasted round trips per page (200-400ms pure waste). 
      Moderate risk — touches every page and action function 
      signature.
- [ ] Sequential query chains on Mapping/Transform/Outputs — 5-9 
      sequential hops that could be parallelized or collapsed 
      into nested selects. Moderate-to-high risk — restructures 
      core fetch logic for 3 pages.
- [ ] NL→SQL token inefficiency — 180:1 input-to-output token 
      ratio (~30K input for ~164 output). Cached, compressed 
      schema context would cut 80%+. Full analysis in `docs/
      unit-economics.md`.
- [ ] Prompt caching priority order (by tokens saved): transform 
      SQL system prompt (~330K tokens over 150 calls), fix engine 
      system prompt (~74K over 20 calls), quality detection 
      system prompt + doc block. Transform loop alone saves 
      ~$1.65 at 300T tier.
- [ ] Haiku 4.5 migration candidates (quality-safe): schema 
      enrichment, transform descriptions, validation rules, DDL 
      parsing. Transform descriptions alone save ~$12/migration 
      at 300T scale.
- [ ] Context window ceiling at 300+ tables — chunking strategy 
      needed (table groups, batched mapping calls). Product 
      ceiling, not just cost ceiling.

---

## Backlog — Lower priority

### SSO-related (customer-triggered)
- [ ] Single Logout (SLO) support — SAML SLO + IdP session 
      binding. Build when a customer asks.
- [ ] Self-service SSO configuration UI for org admins. Build at 
      5-10 customers or before Series A.
- [ ] Session invalidation on SCIM deactivate. Part of SCIM epic.
- [ ] Configurable session lifetime per org. Customer-triggered.
- [ ] Encrypted SAML assertions. Customer-triggered.
- [ ] Periodic forced re-auth. Customer-triggered.
- [ ] Per-org user email allowlist for JIT provisioning. 
      Customer-triggered (~4-hour feature).
- [ ] Read-only `public.sso_providers` mirror table for 
      debuggability.
- [ ] SAML request signing + encrypted assertions. Verify 
      Supabase Pro support; document for regulated customers.
- [ ] OIDC support (SAML-only at launch; add if customer asks).
- [ ] Cross-org guest project access (external collaborators via 
      SSO). Enable customers (e.g., platform vendors like Rootstock, 
      consultancies) to invite users from external organizations to 
      specific projects without granting full org membership. 
      Pattern modeled on Microsoft Teams B2B guest, Slack Connect, 
      Notion guests, Figma external viewers. Seven-point security 
      model: guest identity in home tenant / explicit guest badge / 
      scoped access / bilateral admin controls / bilateral audit 
      logging / SCIM revocation propagation / separate license 
      counting. Scope-dependent, multi-sprint effort. Build when a 
      customer (likely Rootstock-type platform vendor or 
      consultancy) explicitly requests it. Current schema supports 
      it at RLS level; UI, invite flow, audit, and admin controls 
      all need building.

### Product features (customer-triggered or post-funding)
- [ ] Oracle PL/SQL dialect support — large enterprises, 
      especially finance/insurance/government legacy ERP.
- [ ] Snowflake SQL dialect support — moved to Sprint 8 for 
      Mitratech (see above).
- [ ] Python ETL export.
- [ ] DB2 SQL support — niche declining market.
- [ ] SQLite support — not used in enterprise migrations.
- [ ] Duplicate vendor detection — case-insensitive match is 
      quick win if customer asks; fuzzy match is a rabbit hole, 
      don't build speculatively.
- [ ] Save projects as templates — platform-maturity feature, 
      matters at 20+ customers with similar migrations.
- [ ] Unified view of all ingested data — show all ingestion 
      methods in one place.
- [ ] Agent-based connector for on-prem/VPN databases — CLI 
      version ~1 week, full Docker/web version 3-4 weeks. Build 
      when specific design partner has on-prem DB.
- [ ] Windows Authentication for MS SQL.
- [ ] Show preview of invalid data in Validate tab.
- [ ] Landing page SEO polish — FAQ regression, 2-2-1 challenge 
      layout (~a couple hours of work).

### Scope-deferred
- [ ] Organization deletion / data export flow (part of GDPR 
      work).

---

## Known issues (not yet triaged)
_(Items land here when discovered but not yet decided on. 
Graduate to "Planned" or "Rejected" once a decision is made.)_

---

## Rejected (with reason)
- [x] BYOC (Bring Your Own Cloud) — not planned for this product. 
      Revisit at Series A+ with customer demand.
- [x] FedRAMP readiness — 6-12 months and $500K-$2M cost; not 
      viable pre-Series A.
- [x] HIPAA readiness — not selling to healthcare verticals at 
      this stage.
- [x] Amazon Redshift dialect — close enough to PostgreSQL that 
      the PG dialect works with minor tweaks. Don't maintain a 
      separate adapter.
- [x] BigQuery dialect — rarely a migration target; don't build 
      unless asked.

---

## Process notes

- Cyber insurance (separate track, user-handled): Coalition / 
  At-Bay / Corvus, $3-10K/year.
- SOC 2 Type 1 + 2: both kick off post-pre-seed.
- Anthropic zero-retention email sent 2026-04-19, awaiting 
  response (follow up 2026-04-27 if no reply).
- Pen test vendor outreach in flight:
  - Cobalt: demo rescheduled to 2026-04-21 (tomorrow). Prep doc 
    prepared; will debrief post-call.
  - Include Security: email delivered 2026-04-19; no response 
    yet. Follow up via contact form if no reply by Thursday 
    2026-04-24.
  - Doyensec: email sent 2026-04-19 with updated tier commitment 
    scope; awaiting response.
  - Latacora: skipped (business model mismatch — they sell 
    retained security teams, not one-off pen tests).
  - 4th vendor: decided to skip after Cobalt demo was booked.
- GitHub repo renamed from `kaandincer/mine` → `kaandincer/
  settle` on 2026-04-20 to align with product rebrand. Local 
  remote updated same day. Old URL still redirects temporarily; 
  reliance on redirect deprecated.
- 2026-04-20: Full day of security engineering — completed 
  listUsers refactor (migration 069, `lib/auth/users.ts`, 3 
  refactor commits), `createOrganization` dead code removal, 
  dev rebased onto main. 15 commits on dev ahead of main. SSO 
  epic starts 2026-04-21 after Cobalt call.

### Related design documents
- `docs/etl-architecture.md` — four approaches to ETL pipeline 
  generation, ranked.
- `docs/unit-economics.md` — token cost analysis, prompt caching 
  priorities, Haiku migration candidates, product ceilings at 
  300+ tables.
- `docs/mapping-transform-ux-research.md` — user mental model 
  research, redesign options, scale constraints.

_(These docs do not exist yet. Create them when each area is 
next worked on; seed content from Cursor/Claude analysis done 
2026-04-20.)_

---

## SSO Test Runbook

To re-test SSO end-to-end against the SSO Test org + Okta dev 
tenant:

1. Aggressive cleanup (deletes JIT'd test user + org for clean 
   state):

   `npm run sso:test:cleanup -- --full`

2. Re-create test infrastructure:

   `npm run sso:test:setup`

   - Creates SSO Test org (slug `sso-test`)
   - kaan@usesettle.ai owner membership
   - GoTrue SAML provider for Okta dev tenant
   - `sso_providers` row + `sso_domains`: `gmail.com` mapping
   - PUTs `domains: ['gmail.com']` to GoTrue provider
   - Flips `organizations.sso_enabled = true`

3. Clear webpack cache (REQUIRED if dev server has been running 
   across setup/cleanup cycles):

   - In dev server terminal: Ctrl+C
   - `rm -rf .next`
   - `npm run dev -- -p 3001`
   - Wait for "Ready" before retesting

4. Test from fresh incognito window:

   - http://localhost:3001/sso/start?org=sso-test
   - Login as `kaandincer1+ssotest@gmail.com` / 
     `Settle-SSO-Test-2026!`
   - Should land on `/app/projects` authenticated with `viewer` 
     role in SSO Test org

5. Verify state via SQL:

   - `org_memberships` row exists with 
     `provisioning_source='jit'`
   - `sso_identity_links` row exists
   - `sso_audit_events` shows `sso.login.success` with 
     `is_new_membership=true`
   - `auth.identities` has exactly 1 `sso:*` row for the test 
     user

Required env vars in `.env.local`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL=http://localhost:3001` (security worktree 
  only)
- `SSO_ATTEMPT_COOKIE_SECRET` (generate with 
  `openssl rand -hex 32`)

### Rate limiter sanity check (new in B-2-a-i)

After Phase 7 happy-path login succeeds, verify rate limiting:

1. From the same incognito window or a curl loop, hit 
   `/sso/start?org=sso-test` 12+ times in <60s:

   ```bash
   for i in {1..12}; do
     curl -sI -w "%{http_code} %{redirect_url}\n" -o /dev/null \
       "http://localhost:3001/sso/start?org=sso-test"
   done
   ```

2. The 11th+ requests should redirect to 
   `/login?reason=sso_rate_limited`.

3. Verify in Supabase:

   ```sql
   SELECT event_type, metadata->>'reason', metadata->>'key_kind', created_at
   FROM sso_audit_events
   WHERE metadata->>'reason' = 'rate_limited'
   ORDER BY created_at DESC LIMIT 5;
   ```

   Should show recent rows with `key_kind='sso-start'`.

4. To reset between tests: rate limit window is 60 seconds, so 
   wait 60s. Or namespace via a different `org_slug` to use a 
   different bucket key.

Required env vars in `.env.local` for the rate limiter:

- `UPSTASH_REDIS_REST_URL` (from Upstash dashboard, dev 
  database)
- `UPSTASH_REDIS_REST_TOKEN` (from Upstash dashboard, dev 
  database)

---

## Completed

- [x] 2026-04-20 — Removed dead code: `createOrganization` 
      function in `lib/actions/organizations.ts` (unreachable 
      since commit b752919, all call sites migrated to 
      `adminCreateOrganization` or inlined `supabaseAdmin` 
      inserts) + stale comment cleanup in 
      `lib/actions/auth.ts:133`. Commit: 5b1b89c.
- [x] 2026-04-20 — Rebased dev onto main to pull in 
      OutputsContent hotfix (commit b1c3c21). Dev is now a 
      strict superset of main; future dev→main merges will be 
      clean fast-forwards.
- [x] 2026-04-20 — Migration 069: created 
      `find_auth_user_by_email` + `get_auth_emails_by_ids` 
      SECURITY DEFINER RPCs. Applied to production Supabase. 
      Commit: 89a520b (post-rebase).
- [x] 2026-04-20 — Added `lib/auth/users.ts` helper module 
      (`findAuthUserByEmail`, `authUserExistsByEmail`, 
      `getAuthEmailsByIds`). Commit: 0bf0873.
- [x] 2026-04-20 — Commit 3.1 of listUsers refactor: replaced 
      `listUsers` scan in `getOrgMembers` + `adminGetOrgMembers` 
      (`lib/actions/organizations.ts`) with `getAuthEmailsByIds`. 
      Commit: 9f542f5.
- [x] 2026-04-20 — Completed listUsers refactor: all 5 call 
      sites migrated to SECURITY DEFINER RPC-backed helpers from 
      `lib/auth/users.ts`. Commits: 9f542f5 (org member 
      listings), 0809b6a (invite creation pre-check), a87c029 
      (public invite page). Silent correctness ceiling at 1000 
      users eliminated; all `auth.users` access now flows 
      through 3 named, audited RPCs with EXECUTE granted only 
      to `service_role`.
- [x] 2026-04-21 — Migration 070 applied to production: SAML 2.0 
      SSO foundation. Adds `sso_providers`, `sso_domains`, 
      `sso_identity_links`, `sso_audit_events` tables + 6 SECURITY 
      DEFINER RPCs (`lookup_sso_provider_for_domain`, 
      `provision_user_via_jit`, `mark_identity_sso_linked`, 
      `is_sso_user`, `get_auth_identity_providers`, 
      `count_password_only_users_in_org`) + SSO columns on 
      `organizations` / `org_memberships` / `org_invites` + 
      SELECT-only RLS policies + `sso_audit_events` placeholder. 
      All grants are `service_role`-only except `is_sso_user` (also 
      `authenticated`, for middleware). Verified V1–V10 post-apply. 
      Commit: 4d909ab (Prompt A1 of SSO epic).
- [x] 2026-04-21 — SSO Prompt A complete (A1 + A2). Migration 070 
      + types + call-site propagation + 5 new application files:
        - `lib/sso/gotrue-admin.ts` (GoTrue REST helper)
        - `lib/sso/email-hash.ts` (pure sync SHA-256 hash utility)
        - `lib/actions/sso-audit.ts` (audit event emitter)
        - `lib/actions/sso.ts` (8 server actions for SSO admin)
        - `app/sso/start/route.ts` (IdP-initiated bookmark endpoint)
      Locked 27 design decisions across A1 + A2 sessions. All 
      admin-gated actions use `requirePlatformAdmin()`. 
      `checkSSOEnabledForEmail` is the only public action; logs 
      `email_hash` per call for observability. RPC grants 
      `service_role`-only except `is_sso_user` (`authenticated`). 
      Commits: 4d909ab (A1), b4bf5cf (A2).
- [x] 2026-04-27 — Reusable SSO test harness: `scripts/
      sso-test-setup.ts` (Phase 6 — provisions "SSO Test" org with 
      slug `sso-test`, kaan@usesettle.ai as owner, `sso_domains` 
      row mapping `gmail.com`, GoTrue SAML provider via Admin API, 
      `sso_providers` row, flips `sso_enabled`) and `scripts/
      sso-test-cleanup.ts` (Phase 10 — reverses these; default 
      mode preserves the org/memberships/JIT'd test user, `--full` 
      removes everything). Wired into `package.json` as 
      `npm run sso:test:setup` / `npm run sso:test:cleanup`. 
      Will be reused for B-2-a, B-2-b, B-2-c validation. 
      Commit: b843625.
- [x] 2026-04-28 — Decision 29 (SAML cross-tenant check) 
      unblocked via empirical format verification. Phase 9 of the 
      Okta runbook (real SAML round-trip with the test harness 
      above) confirmed: `auth.identities.provider` for a 
      SAML-authenticated user equals the literal string 
      `"sso:" + <supabase_provider_id>` (e.g., 
      `"sso:217246fc-d5a1-4709-b234-c983206dfc65"`). Direct 
      string equality is sufficient for the cross-tenant check 
      in B-2-a; no regex/parse is needed. Settles the assumption 
      flagged when migration 070's `get_auth_identity_providers` 
      RPC was scoped.
- [x] 2026-04-28 — End-to-end SAML round-trip executed against 
      Okta (Phase 7 of runbook) on the prod Supabase project. 
      Confirms PKCE cookie persistence across `/sso/start` → 
      Okta → `/api/auth/callback?type=sso` (previously a 
      known-unknown — see Testing tasks → SSO). 
      `exchangeCodeForSession` succeeds and a Supabase session 
      cookie is set. JIT provisioning gap discovered in the same 
      session and tracked under SSO Prompt B above (B-2-a).
- [x] 2026-04-28 — End-to-end SAML round-trip executed with full 
      B-2-a-ii security pipeline. All six checks ran clean: 
      attempt cookie verified (HMAC-SHA256), provider resolved 
      from session, cross-tenant matched, domain-provider matched, 
      no duplicate accounts, JIT provisioning succeeded with 
      `was_new=true`, identity link succeeded. 
      `sso.login.success` audit emitted with bounded metadata 
      (`email_hash`, no PII). Verification queries against prod 
      Supabase confirmed 1 `org_memberships` row, 1 
      `sso_identity_links` row, 0 failure events. See commit 
      `e9c217d`.
- [x] 2026-04-28 — Debugging note: during repeated setup/cleanup 
      test cycles, observed Next.js dev server serving stale 
      compiled routes that referenced previous-generation UUIDs 
      even after Settle DB and GoTrue both updated to new values. 
      Root cause: webpack disk cache in `.next/`. Manifestation: 
      "No such SSO provider" errors with valid provider IDs. 
      Fix: `rm -rf .next` before retesting after a 
      `cleanup --full`. Codified in the new SSO Test Runbook 
      below.
- [x] 2026-04-28 — Setup script bug discovered: 
      `scripts/sso-test-setup.ts` creates the GoTrue SAML provider 
      via `POST /auth/v1/admin/sso/providers` but did not 
      subsequently attach domain claims via `PUT` to 
      `/auth/v1/admin/sso/providers/<id>`. Result: GoTrue's 
      `domains: []` for the provider, while Settle's `sso_domains` 
      table had the row. Worked around manually mid-debugging via 
      curl `PUT`. Permanent fix shipped: `gotruePut` helper added 
      and called after the provider POST (idempotent — Supabase's 
      Admin API overwrites the domains array on each PUT).
- [x] 2026-04-28 — B-2-a-i shipped. Upstash Redis-backed 
      sliding-window rate limiter wired into the two 
      unauthenticated SSO surfaces (`/sso/start` and 
      `checkSSOEnabledForEmail`). New abstraction at 
      `lib/rate-limit/upstash.ts` (10/min sliding, prevents 
      59s/61s burst-bypass). New canonical IP extractor at 
      `lib/auth/get-client-ip.ts` (null-on-miss for fail-closed 
      policy). Smoke-tested with 12-request curl loop: 11th 
      request correctly redirected to 
      `/login?reason=sso_rate_limited` and emitted 
      `sso.login.failure` with `metadata.reason='rate_limited'`. 
      See commit `3dacb92`.
- [x] 2026-04-28 — Defense-in-depth: narrowed 
      `checkSSOEnabledForEmail`'s return shape from 
      `{ required, orgId?, orgSlug?, providerId?, 
      enforcementMode? }` to `{ required, orgSlug? }`. Removes 
      unauthenticated leak of internal `org_id`, `providerId`, 
      and `enforcement_mode`. Verified zero callers of the old 
      shape exist in the codebase before narrowing. Internal 
      callback at `app/api/auth/callback/route.ts:283` calls the 
      underlying RPC directly, not the public action, so 
      unaffected.
- [x] 2026-04-28 — Pre-push checklist completed: 
      `SSO_ATTEMPT_COOKIE_SECRET`, `UPSTASH_REDIS_REST_URL`, 
      `UPSTASH_REDIS_REST_TOKEN` provisioned in Vercel for 
      Production and Preview scopes. Separate values from local 
      development (different secret bytes; separate Upstash 
      database `settle-rate-limit-prod` vs 
      `settle-rate-limit-dev`). Branch `feat/sso-okta-setup` 
      ready to push to origin.