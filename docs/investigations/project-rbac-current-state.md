# Project-Level RBAC — Current State Investigation

**Branch:** `feat/project-rbac`
**HEAD:** `bdaaa44` (matches `origin/main`)
**Working tree:** clean
**Date:** 2026-04-28
**Mode:** read-only investigation. No migrations or mutating queries were executed. No application files were modified.

---

## 1. Summary

- **Schema is fully scaffolded.** Migration `050_organizations.sql` already creates `organizations`, `org_memberships`, `org_invites`, **and `project_members`**, plus all the SECURITY DEFINER role helpers (`user_can_access_project`, `get_user_project_role`, `user_has_project_role`) and project-scoped RLS on every downstream table. There is nothing to invent at the data-model layer for a basic project-RBAC build.
- **`project_members` is dormant scaffolding.** The table is queried in exactly two TypeScript files (`lib/actions/role-resolution.ts`, `lib/actions/projects.ts`) and inserted in exactly one place (`createProject` adds the creator as `'owner'`). It is **never** populated when an org member is invited or onboarded. For 99% of users today, every read returns 0 rows.
- **Org membership is the de facto project ACL today.** The `projects` SELECT policy is `org_id IN (user's orgs) OR id IN (user's project_members)` — the OR collapses to org-wide visibility for everyone in the org. `get_user_project_role` falls back from `project_members.role` (always NULL today) to `org_memberships.role`, so an org-level editor effectively has editor access on every project in the org.
- **App-level enforcement is consistent** through `requireProjectPermission` / `checkProjectPermission` (mirror of the SQL helper) called from ~17 Server-Action files and `useProjectRole` on ~10 client components. Both consult `project_members` first then fall through to `org_memberships` — same fallback as SQL.
- **No project-level member management UI exists.** Org member management is fully built (`/app/settings/organization`); the per-project equivalent does not exist. There is a stale-looking `app/app/settings/members/MembersContent.tsx` component, but the route page at `app/app/settings/members/page.tsx` is just a redirect to the org settings page — `MembersContent` is effectively orphaned.
- **`projects.visibility` column exists but is unused.** Migration 050 added `visibility VARCHAR(10) NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'private'))`. No RLS policy and no TypeScript code references the column for gating; only the type alias in `lib/types/database.ts:9` mentions it.
- **Two role taxonomies are *almost* identical, with a known foot-gun.** Org and project use the same set today: `owner | admin | editor | viewer` (after `052_remove_reviewer_role.sql`). But `project_members.role` allows `NULL` (the `CHECK` constraint does not enforce `NOT NULL`), and `role-resolution.ts:21` short-circuits `if (pmRow?.role)` — meaning a NULL row silently falls through to the org role. `docs/outstanding-items.md` already flags this as a latent bug.
- **The `project_members` SELECT RLS policy is loose by design.** `org_members_can_view_project_members` lets anyone with project access read the full member list. `outstanding-items.md` (Tier 2) flags this as a cross-tenant leak the moment cross-org guest access ships, but it is harmless under today's strictly-internal access pattern.
- **Service-role caveats are limited but real.** `archiveProject` in `lib/actions/projects.ts` and aggregations in `lib/actions/_outputs-core.ts` / `lib/actions/outputs.ts` go through `supabaseAdmin` (RLS-bypassed) for system-managed reads; both are gated by an SSR-side `checkProjectPermission` call first, so they are safe today. The `app/api/cron/auto-archive` route is a known service-role gap (calls `archiveProject` with no user session) — orthogonal to project RBAC, but worth noting.
- **Bottom line:** This is **"extend the existing scaffolding"**, not "build new". The destructive-migration risk is low: backfilling `project_members` is additive and idempotent. The hard product calls are about the *pattern* of org→project access (auto-grant vs. explicit invite), not the engineering shape.

---

## 2. Data model

### 2.1 Tables

All four tables created in `supabase/migrations/050_organizations.sql`. RLS policies were rewritten in `051_fix_circular_rls.sql` (to break a circular RLS evaluation) and `067_tighten_org_invites_rls.sql` (to drop a permissive token-read policy). The `reviewer` role was removed in `052_remove_reviewer_role.sql`. Migration `070_sso.sql` later added SSO-related columns to `organizations`, `org_memberships`, `org_invites`.

**`public.organizations`** (`050:9-15`)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `name` | VARCHAR(255) | — | NOT NULL |
| `slug` | VARCHAR(100) | — | NOT NULL, UNIQUE |
| `created_at` | TIMESTAMPTZ | `now()` | NOT NULL |
| `created_by` | UUID | — | FK → `auth.users(id)` |
| (SSO columns from 070) | | | `sso_enabled`, `enforcement_mode`, `sso_configured_at` |

**`public.org_memberships`** (`050:17-26`)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `org_id` | UUID | — | FK → `organizations(id)` ON DELETE CASCADE, NOT NULL |
| `user_id` | UUID | — | FK → `auth.users(id)` ON DELETE CASCADE, NOT NULL |
| `role` | VARCHAR(20) | `'viewer'` | NOT NULL, CHECK (`'owner','admin','editor','viewer'`) — post-052 |
| `invited_by` | UUID | — | FK → `auth.users(id)` |
| `invited_at` | TIMESTAMPTZ | — | |
| `joined_at` | TIMESTAMPTZ | `now()` | NOT NULL |
| (SSO column from 070) | | | `provisioning_source` |

UNIQUE constraint on `(org_id, user_id)`. Indexes: `idx_org_memberships_user(user_id)`, `idx_org_memberships_org(org_id)`.

**`public.org_invites`** (`050:28-38`)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `org_id` | UUID | — | FK → `organizations(id)` ON DELETE CASCADE |
| `email` | VARCHAR(255) | — | NOT NULL |
| `role` | VARCHAR(20) | `'viewer'` | NOT NULL, CHECK (same as memberships) |
| `token` | VARCHAR(64) | — | NOT NULL, UNIQUE |
| `invited_by` | UUID | — | FK → `auth.users(id)` |
| `created_at` | TIMESTAMPTZ | `now()` | NOT NULL |
| `accepted_at` | TIMESTAMPTZ | — | |
| `expires_at` | TIMESTAMPTZ | `now() + 7 days` | NOT NULL |

Indexes: `idx_org_invites_token`, `idx_org_invites_email`.

**`public.project_members`** (`050:40-48`)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | `gen_random_uuid()` | |
| `project_id` | UUID | — | FK → `projects(id)` ON DELETE CASCADE, NOT NULL |
| `user_id` | UUID | — | FK → `auth.users(id)` ON DELETE CASCADE, NOT NULL |
| `role` | VARCHAR(20) | — | **Nullable** (no `NOT NULL`); CHECK (`'owner','admin','editor','viewer'`) — post-052 |
| `assigned_at` | TIMESTAMPTZ | `now()` | NOT NULL |
| `assigned_by` | UUID | — | FK → `auth.users(id)` |

UNIQUE on `(project_id, user_id)`. Indexes: `idx_project_members_user`, `idx_project_members_project`.

**`public.projects` additions** (`050:54-56`)

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `org_id` | UUID | — | FK → `organizations(id)`. Set to NOT NULL after backfill (`050:128`). |
| `created_by` | UUID | — | FK → `auth.users(id)` |
| `visibility` | VARCHAR(10) | `'org'` | NOT NULL, CHECK (`'org'`,`'private'`). **Unused.** |

Index: `idx_projects_org(org_id)`.

### 2.2 Role taxonomy

Both `org_memberships.role` and `project_members.role` use the same set after `052_remove_reviewer_role.sql`:

```text
owner=4 > admin=3 > editor=2 > viewer=1
```

Defined in two places that must stay in sync:

- SQL (`052:30`) — `'{"owner":4,"admin":3,"editor":2,"viewer":1}'::JSONB`, used by `user_has_project_role`.
- TS (`lib/types/organizations.ts:3-8`) — `ROLE_HIERARCHY`, used by `checkProjectPermission` / `useProjectRole`.

`org_invites.role` and `project_members.role` were updated to drop `'reviewer'` in 052. Existing `'reviewer'` rows were converted to `'viewer'` in the same migration.

### 2.3 Current population state of `project_members`

**Insert sites** — exactly one (in production application code):
- `lib/actions/projects.ts:82-84` — `createProject` adds the creator as `'owner'` immediately after the project insert.

**Delete sites** — exactly one:
- `lib/actions/organizations.ts:195-199` — `removeMember` sweeps `project_members` for the removed user across all org projects, via `supabaseAdmin`.

**Read sites** (TypeScript) — exactly one path:
- `lib/actions/role-resolution.ts:14-19` — `getUserProjectRole` checks `project_members` first, then falls back to `org_memberships`.
- `_projects-core.ts` and `getProjectsWithStatsInternal` do **not** filter on `project_members` — they rely on the `projects` SELECT RLS policy to do that hop transparently.

**Migration / seed inserts** — none. `050:80-101` backfills `org_memberships` for existing projects (creates one org per pre-existing user, owner role), but it does **not** backfill `project_members`. There is no seed file that inserts into `project_members`.

**Conclusion:** Today, the only rows in `project_members` are one row per project, for whoever clicked "New Project". An org member who joined via invite has zero `project_members` rows.

### 2.4 Indexes & FKs (for completeness, beyond what's tabled above)

All FKs in 050 use `ON DELETE CASCADE` for the user/project/org axes. No multi-column indexes beyond the `UNIQUE (org_id, user_id)` and `UNIQUE (project_id, user_id)` constraints, which serve as covering indexes for membership lookups.

---

## 3. Authorization functions

### 3.1 SQL definitions (all `SECURITY DEFINER STABLE`)

| Function | Defined at | Purpose |
|----------|-----------|---------|
| `public.user_can_access_project(p_project_id UUID) → BOOLEAN` | `050:134-144` | True if the caller is in the project's org **OR** has a `project_members` row. The OR is what makes today's access org-wide. |
| `public.get_user_project_role(p_project_id UUID, p_user_id UUID) → VARCHAR(20)` | `050:146-154` | Returns `project_members.role` if present, else `org_memberships.role`. **`project_members` takes precedence.** |
| `public.user_has_project_role(p_project_id UUID, p_min_role VARCHAR(20)) → BOOLEAN` | `050:156-166`, redefined `052:26-36` | Hierarchical role check using the JSONB hierarchy literal. |
| `public.get_user_org_ids() → SETOF UUID` | `051:19-22` | All orgs the caller belongs to. |
| `public.get_user_admin_org_ids() → SETOF UUID` | `051:24-28` | Subset where the caller is `'owner'` or `'admin'`. |
| `public.is_platform_admin(check_user_id UUID) → BOOLEAN` | `068:61-71` | Platform-admin gate; orthogonal to project RBAC but used in the same enforcement layer. |

There are **no** `user_has_org_role` / `get_user_org_role` SQL functions. Org-level role checks happen inline in TS (`organizations.ts`, `org-invites.ts`, `app/app/projects/page.tsx`) by selecting `role` from `org_memberships` and comparing in JS.

### 3.2 SQL callsites (RLS only — never invoked from TS)

`user_can_access_project` and `user_has_project_role` are referenced **exclusively** from RLS `USING` / `WITH CHECK` clauses in migrations. There are no `supabase.rpc('user_has_project_role', ...)` calls anywhere in the codebase. Coverage in 050 (rewritten as needed in 051):

- `projects` — view via `org_id IN get_user_org_ids() OR id IN project_members` (`051:78-81`); update via `user_has_project_role(id, 'editor')` (`050:272-273`); delete via `user_has_project_role(id, 'admin')` (`050:275-276`).
- `project_members` — view via `user_can_access_project` (`050:255-256`); manage via `user_has_project_role(project_id, 'admin')` (`050:258-259`).
- All project-scoped child tables (datasets, table_mappings, quality_issues, outputs, validation_rules, fix_history, activity_log, field_acknowledgments, db_connections, tables, schema_documents, fields, data_rows, field_profiles, field_mappings, staged_data_rows, transformations, fix_snapshots) — SELECT via `user_can_access_project`, write via `user_has_project_role(..., 'editor')`, with hop-through joins for tables nested under datasets/tables/field_mappings/fix_history. See `050:280-528`.
- Migration redesign tables in `074_mapping_redesign_data_migration.sql` reuse the same helpers.
- `076_dq_apply_field_transform_joined_cross_table.sql` references `user_has_project_role` from new RPCs.
- `070_sso.sql` references `user_has_project_role` only in its commit-message comment (no actual policies).

### 3.3 TypeScript mirror (`lib/actions/role-resolution.ts`)

Three exports, all `'use server'`:

- `getUserProjectRole(projectId): Promise<OrgRole | null>` — re-implements the SQL `get_user_project_role` semantics: read `project_members.role` for `(projectId, user.id)`; if not present, read `org_memberships.role` for the project's org.
- `checkProjectPermission(projectId, minRole): Promise<boolean>` — wraps `getUserProjectRole` with `ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minRole]`.
- `requireProjectPermission(projectId, minRole): Promise<{allowed, error?}>` — wraps `checkProjectPermission`; returns a structured `{allowed: false, error: 'Insufficient permissions...'}` when denied.

### 3.4 TS callsite map (representative; full list in §4)

`requireProjectPermission` / `checkProjectPermission` are imported in 17 Server-Action files (counts shown for context — exact line numbers in §4):

- `lib/actions/mappings.ts` — 15 callsites, all `'editor'`
- `lib/actions/mappings-for-redesign.ts` — 12 callsites, mostly `'editor'`, two `'viewer'` (preview)
- `lib/actions/transformations.ts` — 13 callsites, mix of `'editor'` and one `'viewer'`
- `lib/actions/quality-fixes.ts` — 7 callsites, includes one `'viewer'`-level (acknowledgment read flow at line 874)
- `lib/actions/manual-fix.ts` — 3 callsites, all `'editor'`
- `lib/actions/projects.ts` — 3 callsites: `updateProject` (`'editor'`), `deleteProject` (`'admin'`), `archiveProject` (`'admin'`)
- `lib/actions/admin-mapping-flag.ts` — 2 callsites, both `'admin'`
- `lib/actions/csv.ts` — 1 callsite (`'editor'`)
- `lib/actions/db-connector.ts` — 4 callsites (`'editor'`)
- `lib/actions/execution-package.ts` — 1 callsite (`'editor'`)
- `lib/actions/field-acknowledgments.ts` — 2 callsites (`'editor'`)
- `lib/actions/fields.ts` — 1 callsite (`'editor'`)
- `lib/actions/migration-runbook.ts` — 1 callsite (`'editor'`)
- `lib/actions/outputs.ts` — 7 callsites (mostly `'editor'`, plus one chk read)
- `lib/actions/schema-documents.ts` — 3 callsites (`'editor'`)
- `lib/actions/staging.ts` — 1 callsite (`'editor'`)
- `lib/actions/validation-rules.ts` — 1 callsite (`'editor'`)

`useProjectRole` (client hook) is consumed in 8 component files: `MappingContent.tsx` (legacy + redesign refs), `TransformContent.tsx`, `DataQualityContent.tsx`, `OutputsContent.tsx`, `ControlPlaneContent.tsx`, `IngestionCard.tsx`, `ProjectMenu.tsx`, `SchemaOverview.tsx`. Used purely for affordance visibility (hide/disable), never as the primary auth gate — server action gates are the source of truth.

---

## 4. Enforcement matrix

Server Actions classified by auth-check style. **Note:** in this codebase, "checks project role" means the action calls `requireProjectPermission` or `checkProjectPermission` — which itself falls back from `project_members` to `org_memberships`. There is no action that consults `project_members` exclusively.

### 4.1 Project-role gated actions (the well-policed set)

| File | Function(s) | Min role | Gate style |
|------|-------------|----------|-----------|
| `lib/actions/projects.ts` | `updateProject` (`:119`) | editor | `checkProjectPermission` |
| `lib/actions/projects.ts` | `deleteProject` (`:140`) | admin | `checkProjectPermission` |
| `lib/actions/projects.ts` | `archiveProject` (`:235`) | admin | `checkProjectPermission` |
| `lib/actions/admin-mapping-flag.ts` | `setMaintenanceMode` / `setUseMappingRedesign` (`:35`, `:62`) | admin | `requireProjectPermission` |
| `lib/actions/csv.ts` | `parseAndStoreCSV` (`:33`) | editor | `checkProjectPermission` |
| `lib/actions/db-connector.ts` | `runConnector` etc. (`:1074`, `:1309`, `:1347`) | editor | mix |
| `lib/actions/execution-package.ts` | `generateExecutionPackage` (`:137`) | editor | `checkProjectPermission` |
| `lib/actions/field-acknowledgments.ts` | `acknowledgeField` / `unacknowledgeField` (`:126`, `:210`) | editor | `requireProjectPermission` |
| `lib/actions/fields.ts` | `updateFieldDefault` (`:86`) | editor | `requireProjectPermission` |
| `lib/actions/manual-fix.ts` | `applyManualFix` etc. (`:87`, `:262`, `:464`) | editor | `requireProjectPermission` |
| `lib/actions/mappings.ts` | 15 actions (legacy mapping write paths) | editor | `requireProjectPermission` |
| `lib/actions/mappings-for-redesign.ts` | 10 editor-gated actions; 2 preview/read at `'viewer'` | editor / viewer | `requireProjectPermission` |
| `lib/actions/migration-runbook.ts` | `generateMigrationRunbook` (`:118`) | editor | `checkProjectPermission` |
| `lib/actions/outputs.ts` | `regenerateOutput` etc. (7 sites at `:110-291`) | editor | `checkProjectPermission` |
| `lib/actions/quality-fixes.ts` | `applyAIQualityFix` etc. (`:110`, `:310`, `:360`, `:522`, `:729`); read flow at `:874` | editor / viewer | mix |
| `lib/actions/schema-documents.ts` | `uploadSchemaDocument` etc. (`:32`, `:260`, `:308`) | editor | `requireProjectPermission` |
| `lib/actions/staging.ts` | `applyTransformAndStage` (`:236`) | editor | `checkProjectPermission` |
| `lib/actions/transformations.ts` | 12 editor-gated actions; one `'viewer'` (`:2431`) | editor / viewer | `requireProjectPermission` |
| `lib/actions/validation-rules.ts` | `saveValidationRule` (`:153`) | editor | `checkProjectPermission` |

### 4.2 Org-role gated actions (no project-level gate)

| File | Function | Check |
|------|----------|-------|
| `lib/actions/projects.ts` | `createProject` (`:62`) | Inline: `org_memberships.role !== 'viewer'` for the target org. |
| `lib/actions/organizations.ts` | `updateMemberRole` (`:115`), `removeMember` (`:165`) | Inline: caller `role IN ('owner','admin')` for the org. |
| `lib/actions/organizations.ts` | `getOrgMembers` (`:66`), `getOrganizationsForUser` (`:43`) | RLS-only (caller must be a member of the org to see rows). |
| `lib/actions/organizations.ts` | `updateOrganization` (`:259`), `leaveOrganization` (`:280`) | RLS-only (`organizations` UPDATE policy enforces `owner|admin`); leave is auth-only with an inline last-owner guard. |
| `lib/actions/org-invites.ts` | `createOrgInvite` (`:16`) | Inline: caller `role IN ('owner','admin')`. |
| `lib/actions/org-invites.ts` | `getPendingInvites` (`:159`), `revokeInvite` (`:176`) | RLS-only via `admins_can_manage_invites` (`051:67-68`). |

### 4.3 Auth-only or service-role-bypassed actions

| File | Function | Notes |
|------|----------|-------|
| `lib/actions/auth.ts` | `signUpWithBotProtection` (`:47`) | Bot-protection + invite validation; uses `supabaseAdmin` to insert org + membership when no org-invite token (`:138-148`) since session is not yet bound. |
| `lib/actions/auth.ts` | `deleteAccount` (`:215`) | Auth-only. Deletes `projects.user_id = user.id` then `supabaseAdmin.auth.admin.deleteUser` — does **not** clean up `project_members` or `org_memberships` rows where the user is referenced as `assigned_by`/`invited_by` (relies on `ON DELETE SET NULL` / `ON DELETE CASCADE`). |
| `lib/actions/org-invites.ts` | `acceptInvite` (`:257`) | Auth-via-`userId` parameter; uses `supabaseAdmin` to insert `org_memberships`. **Does not insert into `project_members`.** |
| `lib/actions/org-invites.ts` | `getInviteByToken` (`:192`), `adminCreateOrgInvite` / `adminGetPendingInvites` / `adminRevokeInvite` | All use `supabaseAdmin` + `requirePlatformAdmin` for the admin-prefixed variants. |
| `lib/actions/invites.ts` | `validateInviteCode` (`:46`), `markInviteUsed` (`:77`), `submitAccessRequest` (`:87`), `generateInviteCode` (`:125`), `approveAndGenerateInvite` (`:170`) | `supabaseAdmin` throughout; admin variants gated by `requirePlatformAdmin`. |
| `lib/actions/profile.ts` | All actions | Auth-only; per-user not per-project. |
| `lib/actions/organizations.ts` | `adminCreateOrganization` (`:20`), `adminGetOrgMembers` (`:214`) | `requirePlatformAdmin` + `supabaseAdmin`. |
| `lib/actions/sso.ts`, `sso-audit.ts` | (entire files) | Platform-admin gated. Outside RBAC scope. |
| `lib/actions/migration-intelligence.ts` | `extractMigrationIntelligence` etc. | Auth-only; uses `supabaseAdmin` to insert system-generated rows. RLS on `migration_intelligence` is user_id-based per `050:535-552`. |
| `lib/actions/activity-log.ts` | `logActivity` (`:92`) | `supabaseAdmin` insert; called from already-gated server actions. |

### 4.4 SECURITY DEFINER RPCs (defined in migrations, not Server Actions)

The codebase uses SECURITY DEFINER RPCs for read-modify-write operations that need to bypass RLS for atomicity but still enforce auth. Project-role gated:

- `transform_apply_*` family (migrations `014`, `076`) — gated via `user_has_project_role(project_id, 'editor')` inside the function body.
- `flag_staged_rows`, `count_staged_rows_with_issues` (`024`, `027`) — same pattern.
- `transform_test_multi_field` (`040`) — same.
- `revert_field_transform` (`054`) — same.
- `execute_data_fix_*` (`026`, `043`) — same.
- `safe_numeric_*` (`030`) — same.

Org/platform-admin gated SECURITY DEFINER RPCs:

- `find_auth_user_by_email`, `get_auth_emails_by_ids` (`069`) — `EXECUTE` granted to `service_role` only.
- `lookup_sso_provider_for_domain`, `provision_user_via_jit`, `mark_identity_sso_linked`, `count_password_only_users_in_org`, `get_auth_identity_providers` (`070`) — `service_role` only.
- `is_sso_user` (`070`) — `authenticated` (called from middleware).
- `is_platform_admin` (`068`) — `authenticated` + `service_role`.

### 4.5 Inconsistencies flagged

- `getProjects()` in `lib/actions/projects.ts:96-105` does a bare `select('*').order(...)` with **no** explicit filter; it relies entirely on the `projects` SELECT RLS policy. This is correct today but would be the first place to check if any future change weakens that policy.
- `getProject(projectId)` (`:107`) similarly relies on RLS. Acceptable.
- `lib/actions/projects.ts:21-22` (`updateProjectLabels`) does **not** call `requireProjectPermission` despite mutating `datasets`. The implicit gate is the `datasets` UPDATE RLS policy (`editors_update_datasets`), so the action is safe — but the inconsistency vs. `updateProject` is worth noting if the team standardizes on explicit gates.
- `lib/actions/projects.ts:207-233` (`reactivateProject`) has **no** `requireProjectPermission` gate. It reads/writes `projects` directly and relies on RLS (`editors_can_update_projects`). Same comment as above.
- `lib/actions/_outputs-core.ts:292-293` reads `projects` and `datasets` via `supabaseAdmin`, bypassing RLS. The function is called from `getOutputsPageDataCore` which is invoked by Server Actions that gate via `checkProjectPermission` first; the bypass is safe-by-construction but creates a quiet coupling between gate and bypass.
- `lib/actions/outputs.ts:297-302` similarly fetches `datasets` and `tables` through `supabaseAdmin`. Same comment.

---

## 5. UI surfaces

### 5.1 Projects list

**File:** `app/app/projects/page.tsx`
**Query path:** `getProjectsWithStats(resolvedOrgId)` → `getProjectsWithStatsInternal(supabase, orgId)` in `lib/actions/_projects-core.ts:136-149`.

```text
.from('projects')
.select('*, datasets(id, role, name)')
.order('created_at', { ascending: false })
.eq('org_id', orgId)   // when orgId provided
```

**Filter source of truth:** RLS on `projects` (`051:78-81`):
`org_id IN (SELECT public.get_user_org_ids()) OR id IN (SELECT project_id FROM public.project_members WHERE user_id = auth.uid())`.

There is **no explicit `project_members` filter in the TS query** — the RLS layer does the work transparently. The org-id `.eq()` is purely for narrowing within a single active org, not for security.

The page also resolves the user's role in the active org (`page.tsx:21-37`) and passes `activeOrgRole` into `<ProjectsList>` to gate the "New Project" button (`ProjectsList.tsx:349`).

### 5.2 Project detail layout

**File:** `app/app/projects/[projectId]/layout.tsx` and child pages.

- Auth check: `supabase.auth.getUser()` + redirect to `/login` if missing (`:18-21`).
- Project visibility check: implicit via `getProject(projectId)` → `select.eq('id').single()` + `.catch(() => notFound())`. RLS rejection presents as `notFound()` to the user.
- Sidebar badge (open blocking issues count) is read via `supabaseAdmin` (`:41-48`) — RLS-bypassed, but the page itself is already gated by the `getProject` call above, so a user who shouldn't see the project gets a 404 before this read runs.
- Per-tab pages (`mapping/`, `transform/`, `outputs/`, etc.) all consume `useProjectRole(projectId)` to gate destructive affordances.

### 5.3 Member management UI

**Org-level — fully built:**
- `app/app/settings/organization/page.tsx` (`:1-90`) — Server-Component shell that resolves the active org and the user's role in it, then renders `<OrganizationSettingsContent>`.
- `app/app/settings/organization/OrganizationSettingsContent.tsx` (608 lines) — invite form (admins only), member list with per-member role-change `<Select>` and remove button, last-owner guards, leave-org danger zone, org-name edit.
- Driven by `lib/actions/organizations.ts` (`getOrgMembers`, `updateMemberRole`, `removeMember`, `updateOrganization`, `leaveOrganization`) and `lib/actions/org-invites.ts` (`createOrgInvite`, `getPendingInvites`, `revokeInvite`).

**Project-level — does not exist.**
- `app/app/settings/members/page.tsx` is a five-line redirect to `/app/settings/organization`. It is not a project-scoped surface; it lives at the *org* settings path.
- `app/app/settings/members/MembersContent.tsx` exists (365 lines, last touched 2026-04-27 18:36) but is **orphaned** — `MembersContent` is only imported by no production page; the redirect at `page.tsx` makes it unreachable. It looks like an earlier draft of org-member management before the design was consolidated into `OrganizationSettingsContent.tsx`. **Worth confirming with Kaan before deletion** — see Open Questions §8.
- No `app/app/projects/[projectId]/members` route exists. No "Members" tab in the project sidebar/navigation.
- No `addProjectMember` / `removeProjectMember` / `updateProjectMemberRole` Server Actions exist. Grepping for `from('project_members').insert(` returns exactly one hit (`projects.ts:82`).
- No invite flow exists at the project scope; `org_invites` is the only invite shape.

**Platform-admin UIs:**
- `app/admin/page.tsx`, `app/admin/organizations/`, `app/admin/invites/` — gated by `requirePlatformAdmin`. These are out of scope for project-level RBAC but exist as a precedent for "an admin can directly create memberships via `supabaseAdmin`".

### 5.4 Role-gated affordances elsewhere

Client components that consume `useProjectRole(projectId).can('edit'|'manage'|'view')` to hide/disable buttons (gates redundantly with server-side checks):

- `app/app/projects/[projectId]/mapping/MappingContent.tsx:2645`
- `app/app/projects/[projectId]/transform/TransformContent.tsx:291`
- `app/app/projects/[projectId]/data-quality/DataQualityContent.tsx:2836`
- `app/app/projects/[projectId]/outputs/OutputsContent.tsx:252`
- `app/app/projects/[projectId]/project/ControlPlaneContent.tsx:380`
- `app/app/projects/[projectId]/project/IngestionCard.tsx:73`
- `app/app/projects/[projectId]/data-overview/SchemaOverview.tsx:381`
- `components/app/ProjectMenu.tsx:103` (the three-dot menu on each project card)

In all cases the gate is **client-side UX only**. The actual enforcement lives in the corresponding Server Actions (§4) and RLS (§3.2). A user who bypasses the UI (curl, devtools) hits the server gate.

---

## 6. Today's access pattern (the critical question)

**Q: When a user is added to an org with role X, what do they see and do across projects in that org?**

A: Concretely, today, when `org_memberships(org_id=O, user_id=U, role=X)` exists and **no** `project_members` row exists for U:

1. **They see every project in org O.**
   - `projects` RLS SELECT policy is `org_id IN get_user_org_ids() OR id IN project_members(user_id=auth.uid())` (`051:78-81`).
   - `getProjectsWithStats` returns the org-scoped list with no further filtering.
2. **`get_user_project_role(p, U)` returns X for every project p in org O.**
   - `project_members` lookup misses; falls back to `org_memberships.role` = X (`050:146-154`).
3. **`user_has_project_role(p, 'editor')` returns true** for every project in O if X is `editor`/`admin`/`owner`.
4. **All editor-gated child-table writes succeed** for every project in O. Child-table RLS is `user_has_project_role(project_id, 'editor')` end-to-end (§3.2).
5. **`updateProject` succeeds** for every project in O if X is `editor`/`admin`/`owner` (`projects.ts:119` → `checkProjectPermission(p, 'editor')` falls back to org role).
6. **`deleteProject` / `archiveProject` succeed** if X is `admin`/`owner`.
7. **Viewer role:**
   - SEEs all projects in the org.
   - All write actions that gate at `'editor'` reject (both at the TS gate via `requireProjectPermission` and at RLS).
   - Cannot create projects (`projects.ts:62-64` inline guard: `if (membership.role === 'viewer') reject`).

**Q: Is `project_members` automatically populated when a user joins an org?**

A: **No.** Two paths add a user to an org:
- `acceptInvite` (`org-invites.ts:257-301`) on org-invite acceptance — inserts only `org_memberships`.
- Personal-org creation during signup (`auth.ts:138-148`) — inserts `organizations` + `org_memberships` for the signup user.
Neither writes to `project_members`. The only path that does is `createProject` (one row, the creator, role `'owner'`).

**Q: Is `project_members` automatically populated for existing projects when an org is set up?**

A: **No.** Migration 050's data-migration block (`050:80-101`) creates one org per pre-existing user and migrates `projects.org_id`, but does **not** seed `project_members` for the project creator (or anyone else). All projects created before 050 have zero `project_members` rows; all projects created after 050 have exactly one (the creator).

**Implication for the new feature:** Switching to project-scoped access means changing two policies + backfilling `project_members`:
- **The OR in the `projects` SELECT policy must change** (to AND, or to a more nuanced predicate that respects `visibility`).
- **The fallback in `get_user_project_role` must be reconsidered.** If kept, org admins always have project admin privileges — useful as a default but breaks "viewer in org but not on this project" semantics.
- **Backfill `project_members`** with one row per existing project per existing org-member, role = their `org_memberships.role`, before flipping the policy. Otherwise every existing user loses access on deploy. This is the migration-shape question that Open Question §8 captures.

---

## 7. Service-role constraints

The codebase has a documented caveat that service-role JWTs lack a `sub` claim, so `auth.uid()` is NULL inside `supabaseAdmin` calls and any `user_has_project_role` check inside an RLS policy or RPC reached via service role fails closed.

### 7.1 Where `supabaseAdmin` is used

Every Server Action file in `lib/actions/` (31 of 44) imports `supabaseAdmin`. The usage falls into four buckets:

1. **Pre-gated reads/writes** — action calls `requireProjectPermission` against an SSR-bound client first, then uses `supabaseAdmin` for the actual mutation/aggregation. The gate establishes auth; the bypass executes the work. Examples:
   - `archiveProject` (`projects.ts:235-374`) — gated by `checkProjectPermission(..., 'admin')` at line 238, then 7 destructive `supabaseAdmin` operations (`data_rows`, storage, `db_connections`, `field_profiles`, `tables`, `projects.update`, `activity_log`).
   - `_outputs-core.ts:292-293`, `outputs.ts:297-302` — read `projects` / `datasets` / `tables` via `supabaseAdmin` for aggregation; called from already-gated entry points.
   - `migration-runbook.ts:141-209`, `execution-package.ts:160-161` — same pattern.
   - All AI/quality detection and cascade-fix paths.
2. **System-managed inserts** — actions that write rows whose RLS policy would be inconvenient or impossible to satisfy under the user's session. Examples:
   - `activity-log.ts:92-93` — every gated action calls this to log; insert via `supabaseAdmin`.
   - `migration-intelligence.ts:929-930` — system-extracted intelligence rows.
   - `ai-quality-detection.ts:371-372` — bulk inserts of detected issues.
   - `outputs` regeneration paths.
3. **Auth-flow uses where session is not yet established** — examples:
   - `auth.ts:138-148` — create personal org + org membership for a fresh signup before the session cookies are available.
   - `org-invites.ts:257-300` (`acceptInvite`) — insert `org_memberships` for the accepting user; the call comes from the signup callback where session timing is awkward.
   - `org-invites.ts:192-218` (`getInviteByToken`) — public landing page reads the invite by token before the user is logged in.
4. **Platform-admin paths** — gated by `requirePlatformAdmin` (which itself uses `supabaseAdmin.rpc('is_platform_admin')`). All `admin*` exports and all routes under `app/admin/`. Out of scope for project RBAC.

### 7.2 Project-membership logic that runs through service role

This is the question the prompt specifically asked about. Audit:

- **`organizations.ts:195-199`** — `removeMember` deletes `project_members` rows via `supabaseAdmin`, after first checking the caller is owner/admin of the org via SSR client. Constraint: the bulk delete is correct today but if the new feature introduces project-only owners (someone with admin on a project but no admin on the org), removing them via this org-admin flow is the intended behavior. Worth confirming.
- **`acceptInvite`** (`org-invites.ts:257-301`) does **not** insert into `project_members`. If the new feature is "auto-grant viewer-on-all-org-projects when invited", this is the natural extension point.
- **`createProject`** (`projects.ts:66-89`) inserts into `project_members` via the **SSR client**, not `supabaseAdmin`. This is the only path where `project_members` is written under the user's auth — and it works because the user is the actor and the row's `user_id` is their own UUID. Constraint: the project_members ALL-policy `project_admins_can_manage_members` (`050:258`) requires `user_has_project_role(project_id, 'admin')` — which on a brand-new project with no rows yet would return FALSE. Yet this insert succeeds today. **This is suspicious enough to verify** (see Open Questions §8). Hypothesis: the row insert wins the race because `INSERT ... WITH CHECK` evaluates `user_has_project_role` against the row being inserted and `get_user_project_role` returns the org role. Worth confirming experimentally before this code path is touched.
- **No code path** writes `project_members` via `supabaseAdmin`. So service-role bypass is not currently a constraint *for* the membership data model — only *around* it.

### 7.3 Out-of-scope service-role gap (worth flagging)

`app/api/cron/auto-archive/route.ts` calls `archiveProject(project.id)` from a cron context with no user session. `archiveProject` calls `checkProjectPermission(..., 'admin')` which uses `supabase.auth.getUser()` against the SSR client — which in the cron context has no auth cookie. The check should fail closed and the cron should report errors per project. This is unrelated to project-RBAC but is a latent reliability bug to surface separately.

### 7.4 Implications for the new feature

The primary service-role consideration for project-level RBAC is **not** that something is currently using service-role to manage project membership (nothing is). It's that **any new RPC or RLS predicate that invokes `auth.uid()` will continue to be NULL in service-role calls**, and any new helper called from `supabaseAdmin.rpc(...)` would need to either accept the user_id as a parameter (like `get_user_project_role(p_project_id, p_user_id)` already does) or be paired with an SSR-side gate. The existing `(p_project_id, p_user_id)` signature on `get_user_project_role` is the right pattern; the auth.uid()-implicit `user_has_project_role(p_project_id, p_min_role)` is the riskier pattern and should be avoided as a primitive in any new service-role path.

---

## 8. Open questions for Kaan

Each phrased as a yes/no or A/B. Numbered for easy reference in your follow-up.

1. **Auto-grant on org join?** When a new user joins an org via `acceptInvite`, should they get a `project_members` row for every project in the org (with role inherited from `org_memberships.role`), or should they only get access to projects they're explicitly added to? **A: auto-grant inheriting org role / B: explicit invite only.**
2. **Auto-grant on project create?** When a project is created in an org with N members, should the other N-1 members be auto-added to `project_members`, or only the creator? **A: all org members / B: creator only.**
3. **Org-admin override?** Should an org owner/admin always retain implicit access to every project in their org, regardless of `project_members` rows — i.e., keep the fallback in `get_user_project_role` for owner/admin only? **Y/N.** (If Y, the role-resolution function changes from `pmRow OR omRow` to `pmRow OR (omRow AND omRow.role IN ('owner','admin'))`.)
4. **Org-editor/viewer scoping?** If org-admin override is Y, should org *editors* and *viewers* lose their automatic access to all projects (so they only see/edit projects they're explicitly added to)? **Y/N.**
5. **`projects.visibility` semantics?** The column exists but is unused. Should the new feature wire it up — `'org'` = current behavior (all org members can access at their org role), `'private'` = `project_members` only? Or rip the column out as dead schema? **A: wire it / B: rip it.**
6. **Project-level role taxonomy?** Keep the four-role set (`owner | admin | editor | viewer`), or simplify the project surface to three roles (drop `admin` since project_members admin doesn't add capability beyond owner)? **A: keep four / B: drop project-admin / C: drop reviewer-style intermediate again later.**
7. **Project ownership transfer?** Today only the project creator is in `project_members` as `owner`. If they leave the org and `removeMember` sweeps their `project_members` rows, the project has no owner. Is "no project_members owner, fallback to any org admin" acceptable, or should we require explicit transfer-of-ownership before removal? **A: implicit fallback / B: require transfer.**
8. **Member-management UI surface?** A: a "Members" tab inside each project (`/app/projects/[id]/members`) — modeled on the existing `OrganizationSettingsContent`. B: a single "Permissions" pane on org settings that lists all projects with expand/collapse member lists per project. **A / B.**
9. **`MembersContent.tsx` — keep or delete?** The orphaned component at `app/app/settings/members/MembersContent.tsx` (365 lines) appears to be an early draft superseded by `OrganizationSettingsContent.tsx`. Safe to delete? **Y/N.**
10. **Loose `project_members` SELECT policy.** `outstanding-items.md` Tier 2 already flags this as cross-tenant-leakable when guest access ships. Tighten as part of *this* epic, or punt to the cross-org-guests epic? **A: tighten now / B: punt.**
11. **NULL `role` on `project_members`.** `outstanding-items.md` flags this latent bug; `role-resolution.ts:21` short-circuits on NULL. Fix in the same migration as the project-RBAC roll-out, or as a stand-alone hotfix earlier? **A: bundle / B: hotfix first.**
12. **Backfill semantics.** When the migration runs, every existing org member gets a `project_members` row for every existing project in their org. Inherit role from `org_memberships.role`? Or default everyone to `viewer` and require admins to grant? **A: inherit / B: viewer-only-default.**
13. **Existing `getProjects()` + `getProjectsWithStatsInternal` — explicit filter or RLS-only?** Today both rely on RLS for project-list scoping. The new feature can keep that contract (just change the RLS predicate) or move to explicit `.in('id', user's project_ids)` filters in TS. **A: keep RLS as source of truth / B: dual filter for defense-in-depth.**
14. **Rootstock-specific?** Is the immediate driver "Rootstock needs to scope what their pilot users can see"? If so, the scope can be much narrower (just turn off the org-wide auto-visibility for that one org via a column flag) than a full per-project membership model. **A: feature for everyone / B: per-org opt-in switch first, full feature later.**

---

## 9. Proposed scope tiers

Day estimates assume a single engineer at the same velocity as the SSO epic that just shipped (Apr 21–23). All include schema migration, application-code changes, tests (unit + integration), and a manual smoke test in a non-prod environment. None include a customer rollout beyond a feature flag.

### 9.1 Tier A — Minimum viable (3–4 working days)

**Goal:** stop the org-wide auto-grant for *visibility*, keep the auto-grant for *editing*. Unblocks "Rootstock pilot users only see the project they were invited to" without rewriting the role-fallback model.

**Scope:**
- New migration:
  - Backfill `project_members` with `(project_id, user_id, role=org_memberships.role)` for the cross-product of every existing project and every member of its org. Idempotent (`ON CONFLICT (project_id, user_id) DO NOTHING`).
  - Tighten the `projects` SELECT RLS to `id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())` — drop the org_id OR clause.
  - Add `NOT NULL` to `project_members.role` (after backfilling NULLs to `'viewer'`).
- App changes:
  - `acceptInvite` writes one `project_members` row per existing org project. Auto-grant on org join (Open Question 1 = A).
  - `createProject` inserts `project_members` rows for every other current org member (Open Question 2 = A).
  - `organizations.ts:removeMember` already cleans up correctly; verify and add a test.
  - `projects.ts:updateProjectLabels` and `:reactivateProject` get an explicit `requireProjectPermission` gate to remove the inconsistencies flagged in §4.5.
- UI:
  - Per-project "Members" panel under `/app/projects/[id]/members` showing the project_members list, with role-change `<Select>` and remove button. Role-gated by `useProjectRole.can('manage')`. Modeled on `OrganizationSettingsContent.tsx`'s member section.
  - Add `addProjectMember` (by org-member email picker, no new invite token), `updateProjectMemberRole`, `removeProjectMember` Server Actions, gated by `requireProjectPermission(..., 'admin')`.

**Out of scope (Tier A):**
- `projects.visibility` enforcement.
- Project-level invites (cross-org or to non-org users).
- Audit logging beyond the existing `activity_log`.
- Tightening `project_members` SELECT RLS.

**Risk:** moderate. The RLS change affects every authenticated read on `projects` and every transitive child-table read via `user_can_access_project`. Backfill must be run *before* the policy change (single migration, two transactions, or a staged deploy).

### 9.2 Tier B — The "right" build (6–8 working days)

**Goal:** Tier A, plus actual project-level access semantics that don't leak by default and that an org admin can manage cleanly.

**Scope (delta over Tier A):**
- Wire up `projects.visibility`:
  - `'org'` (default): all org members get an auto-`project_members` row at their org role on project create. Existing semantics preserved.
  - `'private'`: only explicit `project_members` rows grant access. Visible from the project settings as "Anyone in the org" vs "Only invited members".
  - Migration: existing projects backfill to `'org'`. The setting is editable post-create by project admins.
- Project settings panel (alongside Members) exposes the visibility toggle.
- Project-scoped invites: extend `org_invites` with an optional `project_id` and an optional `project_role`, or add a new `project_invites` table. Acceptance flow inserts `project_members` directly. Gated by project admin. Email template forks.
- Tighten `project_members` SELECT RLS per `outstanding-items.md` Tier 2 (see Open Question 10).
- Audit `activity_log` for new event kinds: `project_member_added`, `project_member_removed`, `project_member_role_changed`, `project_visibility_changed`. Required entries surfaced on the project's existing activity surface.
- Project list card shows the user's effective role per project (badge).
- The `MembersContent.tsx` orphan gets deleted (Open Question 9 = Y).
- Fix the latent NULL-role bug in `role-resolution.ts:21` and tighten the SQL `get_user_project_role` similarly.

**Risk:** moderate-high. Visibility toggle creates a new product affordance — design + copy + analytics needed.

### 9.3 Tier C — Full enterprise-grade (12–16+ working days, multi-sprint)

**Goal:** Tier B, plus the cross-org and provisioning shape that `outstanding-items.md` already flags as scope-dependent.

**Scope (delta over Tier B):**
- Cross-org guest project access (full B2B-guest model from `outstanding-items.md`: guest identity in home tenant, scoped access, bilateral admin/audit, SCIM revocation propagation, separate license counting).
- SCIM hooks for project membership (read-only mirror of `project_members` exposed to identity providers).
- Bulk member management (CSV import; audit-traced).
- Project ownership transfer flow as an explicit guarded action (Open Question 7 = B).
- Per-project role customization (introduce a `project_roles` table allowing per-org or per-project role definitions beyond the four-role default).
- Storage policy rewrite to use org_id/project_id paths, removing the storage-via-`supabaseAdmin` pattern flagged in `050:557-561`.
- Rate-limited invite acceptance + abuse signals.
- Per-project audit-event retention/export.

**Risk:** high. Multi-sprint. Touches identity, storage, and audit subsystems. Should be split into multiple epics with clear feature flags.

---

### Stop-condition assessment

Per the prompt's stop conditions:

- **Pre-conditions: PASS** — branch, HEAD, working tree, deps, env all verified.
- **Existing partial implementation in active use?** YES — the schema is in production, the SQL helpers are referenced by every gated server action and every child-table RLS policy. **This shifts the strategy from "build new" to "extend existing".** Surfaced. Recommend Kaan review §6 + §8 before approving Tier A scope.
- **Destructive migration on existing prod data?** NO — Tier A and B are additive (backfill + new column wiring + RLS tightening). The only potentially-destructive item is the `NOT NULL` on `project_members.role`, and that is preceded by a backfill of NULLs to `'viewer'`. No data is dropped.
- **Tier B exceeds 7 working days?** Estimated 6–8 days with current uncertainty. **Borderline** — if Open Questions 1–4 surface a model that requires more than fallback-tweaking (e.g., per-project capability matrix beyond role hierarchy), this slips past 7. Worth a short sync with Kaan to lock those before committing to Tier B.

No stop condition is fully tripped — proceeding to deliver this report and await your decision.

---

## 10. PR 2 follow-ups (carried over from PR 1)

Items deferred from PR 1 that should be addressed when PR 2 is built. Not blocking PR 1 ship.

1. **Delete `app/app/settings/members/MembersContent.tsx`** — confirmed orphan during PR 1 investigation. PR 1 made the minimum type-compatibility edit so `tsc` passes; PR 2 owns the removal plus any unmounted route/import cleanup.
2. **Convert `createProject` + `grant_new_project_access` into a single transactional `SECURITY DEFINER` RPC.** PR 1 ships with an application-level rollback pattern: the action `INSERT`s the project row, then calls the fanout RPC, and on RPC failure deletes the project via `supabaseAdmin`. This is correct but fragile — between the insert and the delete the project exists with no `project_members` rows, and the rollback depends on the service role still being reachable. The cleaner design is a single RPC `create_project_with_access(p_org_id, p_name, p_description, p_creator_id)` that wraps the project insert and the membership fanout in one transaction, returning the new project row. Server action becomes a thin caller. Eliminates the rollback path and the half-state window.
   - Touch points: new migration adding the RPC; rewrite `createProject` in `lib/actions/projects.ts` to call the RPC and remove the rollback branch; update `tests/actions/projects-rbac-fanout.test.ts` source-level invariants accordingly.
