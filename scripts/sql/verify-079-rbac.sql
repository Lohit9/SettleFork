-- ─────────────────────────────────────────────────────────────────────
-- One-off verification script for migration 079
-- (project-level RBAC strict membership).
--
-- Not part of the test suite. Run by hand against a freshly-started
-- local Supabase stack to demonstrate that:
--
--   1. Migration 079 applied cleanly (no legacy roles remain).
--   2. The fanout RPCs (grant_new_project_access,
--      grant_new_org_member_project_access,
--      backfill_org_member_project_access) write the expected rows
--      with the right roles, idempotently, and respect the
--      member_auto_grant_enabled toggle.
--   3. The strict membership rule actually denies access to org
--      members who lack a project_members row.
--
-- Output is captured to stdout — the host-shell `psql` invocation
-- below tees it to a log file. Paste the log back for review.
--
-- Usage (from repo root, on the host shell, after `supabase start`):
--
--   psql "$(supabase status -o json | jq -r .DB_URL)" \
--        -v ON_ERROR_STOP=1 -X -f scripts/sql/verify-079-rbac.sql \
--        2>&1 | tee /tmp/verify-079.log
--
-- ─────────────────────────────────────────────────────────────────────

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' Migration 079 verification — start'
\echo '════════════════════════════════════════════════════════════════════'

-- ─── Section 1: post-079, empty DB baseline ─────────────────────────
\echo
\echo '─── 1. Post-079 schema baseline (empty fresh DB) ───────────────────'
\echo

\echo '1a. organizations.member_auto_grant_enabled column present + default true:'
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'organizations'
  AND column_name = 'member_auto_grant_enabled';

\echo
\echo '1b. org_memberships CHECK constraint accepts only owner/member:'
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'org_memberships'
  AND con.contype = 'c'
  AND pg_get_constraintdef(con.oid) ILIKE '%role%';

\echo
\echo '1c. project_members CHECK constraint accepts only admin/editor/viewer:'
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'project_members'
  AND con.contype = 'c'
  AND pg_get_constraintdef(con.oid) ILIKE '%role%';

\echo
\echo '1d. The four key SQL functions (post-rewrite, with hierarchy literal):'
SELECT proname,
       pg_get_function_result(oid) AS returns,
       prosrc ~ 'org_memberships' AS body_references_org_memberships,
       prosrc ~ 'project_members' AS body_references_project_members
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('get_user_project_role',
                  'user_can_access_project',
                  'user_has_project_role',
                  'get_user_admin_org_ids')
ORDER BY proname;

\echo
\echo '1e. The three new fanout RPCs exist with SECURITY DEFINER:'
SELECT proname, prosecdef AS security_definer,
       pg_get_function_arguments(oid) AS arguments
FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('grant_new_project_access',
                  'grant_new_org_member_project_access',
                  'backfill_org_member_project_access')
ORDER BY proname;

\echo
\echo '1f. projects SELECT RLS policy now references project_members only:'
SELECT polname,
       pg_get_expr(polqual, polrelid) AS using_clause
FROM pg_policy pol
JOIN pg_class rel ON rel.oid = pol.polrelid
WHERE rel.relname = 'projects'
  AND polcmd = 'r';  -- SELECT

\echo
\echo '1g. Empty-DB post-079 row counts (sanity baseline = all zero):'
SELECT
  (SELECT COUNT(*) FROM public.organizations)     AS organizations,
  (SELECT COUNT(*) FROM public.org_memberships)   AS org_memberships,
  (SELECT COUNT(*) FROM public.projects)          AS projects,
  (SELECT COUNT(*) FROM public.project_members)   AS project_members;


-- ─── Section 2: seed a controlled mini-fixture ──────────────────────
\echo
\echo '─── 2. Seed controlled fixture (orgs/users/projects, NO project_members yet) ───'
\echo

BEGIN;

-- Two orgs:
--   Org X — member_auto_grant_enabled = TRUE  (default). Members
--           should fanout to project-editor on existing projects when
--           the toggle is on; new projects fanout admin/editor at
--           creation; backfill RPC is a no-op when toggle was already
--           on (no missing rows to fill).
--   Org Y — member_auto_grant_enabled = FALSE. Members get NO
--           project_members rows from auto-grant. Backfill RPC is the
--           OFF→ON migration path; we'll flip the toggle and call it
--           explicitly.
INSERT INTO public.organizations (id, name, slug, member_auto_grant_enabled)
VALUES
  ('11111111-1111-1111-1111-111111111101'::uuid, 'V079 Org X (toggle ON)',  'v079-org-x', TRUE),
  ('11111111-1111-1111-1111-111111111102'::uuid, 'V079 Org Y (toggle OFF)', 'v079-org-y', FALSE);

-- Three users: provisioned in auth.users with random passwords. Sign-in
-- isn't required for psql-side checks; auth.uid() simulation comes via
-- request.jwt.claims overrides further down.
INSERT INTO auth.users (id, instance_id, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data,
                        aud, role)
VALUES
  ('22222222-2222-2222-2222-222222222201', '00000000-0000-0000-0000-000000000000',
   'v079-owner@example.test',  '$2a$10$placeholder', now(), now(), now(),
   '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222202', '00000000-0000-0000-0000-000000000000',
   'v079-member@example.test', '$2a$10$placeholder', now(), now(), now(),
   '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222203', '00000000-0000-0000-0000-000000000000',
   'v079-orphan@example.test', '$2a$10$placeholder', now(), now(), now(),
   '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated');

INSERT INTO public.profiles (id, email)
VALUES
  ('22222222-2222-2222-2222-222222222201', 'v079-owner@example.test'),
  ('22222222-2222-2222-2222-222222222202', 'v079-member@example.test'),
  ('22222222-2222-2222-2222-222222222203', 'v079-orphan@example.test')
ON CONFLICT (id) DO NOTHING;

-- Org memberships in NEW taxonomy (owner / member). This is what the
-- post-079 CHECK accepts. We deliberately do not create any
-- project_members rows yet — the fanout RPCs will create them in the
-- next section.
--
-- Owner is in both orgs (so we can test cross-org isolation).
-- Member is only in Org X.
-- Orphan is in Org Y as a member, then promoted in §3d.
INSERT INTO public.org_memberships (org_id, user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222201', 'owner'),
  ('11111111-1111-1111-1111-111111111101', '22222222-2222-2222-2222-222222222202', 'member'),
  ('11111111-1111-1111-1111-111111111102', '22222222-2222-2222-2222-222222222201', 'owner'),
  ('11111111-1111-1111-1111-111111111102', '22222222-2222-2222-2222-222222222203', 'member');

-- Two projects per org, created by the org owner.
INSERT INTO public.projects (id, org_id, name, created_by) VALUES
  ('33333333-3333-3333-3333-333333333301', '11111111-1111-1111-1111-111111111101', 'V079 X-Project-1', '22222222-2222-2222-2222-222222222201'),
  ('33333333-3333-3333-3333-333333333302', '11111111-1111-1111-1111-111111111101', 'V079 X-Project-2', '22222222-2222-2222-2222-222222222201'),
  ('33333333-3333-3333-3333-333333333303', '11111111-1111-1111-1111-111111111102', 'V079 Y-Project-1', '22222222-2222-2222-2222-222222222201'),
  ('33333333-3333-3333-3333-333333333304', '11111111-1111-1111-1111-111111111102', 'V079 Y-Project-2', '22222222-2222-2222-2222-222222222201');

COMMIT;

\echo '2a. Pre-fanout role distribution in org_memberships (owner/member only):'
SELECT role, COUNT(*) AS count
FROM public.org_memberships
WHERE org_id IN ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102')
GROUP BY role
ORDER BY role;

\echo
\echo '2b. Pre-fanout project_members count (expect 0 — no fanout has run):'
SELECT COUNT(*) AS project_members_pre_fanout
FROM public.project_members pm
JOIN public.projects p ON p.id = pm.project_id
WHERE p.org_id IN ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102');


-- ─── Section 3: exercise the fanout RPCs ────────────────────────────
\echo
\echo '─── 3. Run fanout RPCs — simulate event-driven backfill ────────────'
\echo

\echo '3a. grant_new_project_access on each project (simulates createProject events):'
\echo '    expect for Org X (toggle ON): owner gets admin, member gets editor → 2 rows per project × 2 = 4'
\echo '    expect for Org Y (toggle OFF): owner gets admin only → 1 row per project × 2 = 2'
SELECT public.grant_new_project_access(
  '33333333-3333-3333-3333-333333333301'::uuid,
  '11111111-1111-1111-1111-111111111101'::uuid,
  '22222222-2222-2222-2222-222222222201'::uuid
) AS rows_inserted_x1;
SELECT public.grant_new_project_access(
  '33333333-3333-3333-3333-333333333302'::uuid,
  '11111111-1111-1111-1111-111111111101'::uuid,
  '22222222-2222-2222-2222-222222222201'::uuid
) AS rows_inserted_x2;
SELECT public.grant_new_project_access(
  '33333333-3333-3333-3333-333333333303'::uuid,
  '11111111-1111-1111-1111-111111111102'::uuid,
  '22222222-2222-2222-2222-222222222201'::uuid
) AS rows_inserted_y1;
SELECT public.grant_new_project_access(
  '33333333-3333-3333-3333-333333333304'::uuid,
  '11111111-1111-1111-1111-111111111102'::uuid,
  '22222222-2222-2222-2222-222222222201'::uuid
) AS rows_inserted_y2;

\echo
\echo '3b. project_members count + role distribution after grant_new_project_access:'
SELECT
  CASE p.org_id
    WHEN '11111111-1111-1111-1111-111111111101' THEN 'Org X (toggle ON)'
    WHEN '11111111-1111-1111-1111-111111111102' THEN 'Org Y (toggle OFF)'
  END AS org,
  pm.role,
  COUNT(*) AS rows
FROM public.project_members pm
JOIN public.projects p ON p.id = pm.project_id
WHERE p.org_id IN ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102')
GROUP BY p.org_id, pm.role
ORDER BY org, pm.role;

\echo
\echo '3c. Idempotency: re-run grant_new_project_access — expect 0 new rows each:'
SELECT public.grant_new_project_access(
  '33333333-3333-3333-3333-333333333301'::uuid,
  '11111111-1111-1111-1111-111111111101'::uuid,
  '22222222-2222-2222-2222-222222222201'::uuid
) AS reapply_x1;
SELECT public.grant_new_project_access(
  '33333333-3333-3333-3333-333333333303'::uuid,
  '11111111-1111-1111-1111-111111111102'::uuid,
  '22222222-2222-2222-2222-222222222201'::uuid
) AS reapply_y1;

\echo
\echo '3d. Promote orphan to owner in Org Y (simulate updateMemberRole event):'
UPDATE public.org_memberships
SET role = 'owner'
WHERE org_id = '11111111-1111-1111-1111-111111111102'
  AND user_id = '22222222-2222-2222-2222-222222222203';

\echo '    Then run grant_new_org_member_project_access with role=owner — expect 2 admin rows:'
SELECT public.grant_new_org_member_project_access(
  '22222222-2222-2222-2222-222222222203'::uuid,
  '11111111-1111-1111-1111-111111111102'::uuid,
  'owner'::text
) AS rows_inserted_orphan_promoted;

\echo
\echo '3e. Flip Org Y toggle OFF→ON, then call backfill_org_member_project_access:'
\echo '    Org Y has 1 remaining member (after promotion above, orphan is owner).'
\echo '    But originally Org Y had no auto-grant so members[].project_members is empty.'
\echo '    Add a fresh member to Org Y to demonstrate:'
INSERT INTO public.org_memberships (org_id, user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111102', '22222222-2222-2222-2222-222222222202', 'member');

UPDATE public.organizations
SET member_auto_grant_enabled = TRUE
WHERE id = '11111111-1111-1111-1111-111111111102';

\echo '    backfill_org_member_project_access — expect 2 editor rows (1 member × 2 projects):'
SELECT public.backfill_org_member_project_access('11111111-1111-1111-1111-111111111102'::uuid)
  AS rows_inserted_backfill_y;

\echo
\echo '3f. Final project_members snapshot (post all events):'
SELECT
  CASE p.org_id
    WHEN '11111111-1111-1111-1111-111111111101' THEN 'Org X (toggle ON)'
    WHEN '11111111-1111-1111-1111-111111111102' THEN 'Org Y (toggle OFF→ON)'
  END AS org,
  pm.role,
  COUNT(*) AS rows
FROM public.project_members pm
JOIN public.projects p ON p.id = pm.project_id
WHERE p.org_id IN ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102')
GROUP BY p.org_id, pm.role
ORDER BY org, pm.role;


-- ─── Section 4: stickiness + RLS visibility under simulated auth.uid() ───
\echo
\echo '─── 4. Stickiness + RLS visibility for an authenticated user ───────'
\echo

\echo '4a. Stickiness: explicitly remove member from one project, re-run grant_new_project_access,'
\echo '    confirm row stays removed (ON CONFLICT DO NOTHING is correct for non-existing rows;'
\echo '    the real test is that no INSERT statement targets the deleted row):'

-- Snapshot: count for member on project X-1 before/after
\echo '    Before delete + reapply:'
SELECT user_id, project_id, role
FROM public.project_members
WHERE project_id = '33333333-3333-3333-3333-333333333301'
  AND user_id   = '22222222-2222-2222-2222-222222222202';

DELETE FROM public.project_members
WHERE project_id = '33333333-3333-3333-3333-333333333301'
  AND user_id   = '22222222-2222-2222-2222-222222222202';

SELECT public.grant_new_project_access(
  '33333333-3333-3333-3333-333333333301'::uuid,
  '11111111-1111-1111-1111-111111111101'::uuid,
  '22222222-2222-2222-2222-222222222201'::uuid
) AS reapply_after_delete;

\echo '    After delete + reapply (expect 0 rows for member on X-1 — sticky removal):'
SELECT COUNT(*) AS member_rows_on_x1
FROM public.project_members
WHERE project_id = '33333333-3333-3333-3333-333333333301'
  AND user_id   = '22222222-2222-2222-2222-222222222202';

\echo
\echo '4b. RLS visibility — owner (in Org X + Y):'
\echo '    Should see: X-1 (admin), X-2 (admin), Y-1 (admin), Y-2 (admin) = 4 projects'
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222201","role":"authenticated"}';
SELECT id, org_id, name
FROM public.projects
WHERE id IN (
  '33333333-3333-3333-3333-333333333301',
  '33333333-3333-3333-3333-333333333302',
  '33333333-3333-3333-3333-333333333303',
  '33333333-3333-3333-3333-333333333304'
)
ORDER BY name;
RESET ROLE;
RESET request.jwt.claims;

\echo
\echo '4c. RLS visibility — member (in Org X member; not in Org Y):'
\echo '    Should see only X-2 (X-1 was explicitly removed in 4a) = 1 project'
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222202","role":"authenticated"}';
SELECT id, org_id, name
FROM public.projects
WHERE id IN (
  '33333333-3333-3333-3333-333333333301',
  '33333333-3333-3333-3333-333333333302',
  '33333333-3333-3333-3333-333333333303',
  '33333333-3333-3333-3333-333333333304'
)
ORDER BY name;
RESET ROLE;
RESET request.jwt.claims;

\echo
\echo '4d. RLS visibility — orphan (Org Y owner now; not in Org X):'
\echo '    Should see Y-1, Y-2 (admin via promotion fanout) = 2 projects'
\echo '    Should NOT see X-1 or X-2 (no Org X membership at all)'
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222203","role":"authenticated"}';
SELECT id, org_id, name
FROM public.projects
WHERE id IN (
  '33333333-3333-3333-3333-333333333301',
  '33333333-3333-3333-3333-333333333302',
  '33333333-3333-3333-3333-333333333303',
  '33333333-3333-3333-3333-333333333304'
)
ORDER BY name;
RESET ROLE;
RESET request.jwt.claims;


-- ─── Section 5: cleanup + final §L-style summary ────────────────────
\echo
\echo '─── 5. Cleanup + summary ───────────────────────────────────────────'
\echo

DELETE FROM public.project_members
WHERE project_id IN (
  '33333333-3333-3333-3333-333333333301',
  '33333333-3333-3333-3333-333333333302',
  '33333333-3333-3333-3333-333333333303',
  '33333333-3333-3333-3333-333333333304'
);
DELETE FROM public.projects
WHERE id IN (
  '33333333-3333-3333-3333-333333333301',
  '33333333-3333-3333-3333-333333333302',
  '33333333-3333-3333-3333-333333333303',
  '33333333-3333-3333-3333-333333333304'
);
DELETE FROM public.org_memberships
WHERE org_id IN ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102');
DELETE FROM public.organizations
WHERE id IN ('11111111-1111-1111-1111-111111111101', '11111111-1111-1111-1111-111111111102');
DELETE FROM public.profiles
WHERE id IN (
  '22222222-2222-2222-2222-222222222201',
  '22222222-2222-2222-2222-222222222202',
  '22222222-2222-2222-2222-222222222203'
);
DELETE FROM auth.users
WHERE id IN (
  '22222222-2222-2222-2222-222222222201',
  '22222222-2222-2222-2222-222222222202',
  '22222222-2222-2222-2222-222222222203'
);

\echo '5a. Final post-cleanup row counts (should match §1g — all zero):'
SELECT
  (SELECT COUNT(*) FROM public.organizations
     WHERE id::text LIKE '11111111-%')                AS organizations,
  (SELECT COUNT(*) FROM public.org_memberships
     WHERE org_id::text LIKE '11111111-%')            AS org_memberships,
  (SELECT COUNT(*) FROM public.projects
     WHERE id::text LIKE '33333333-%')                AS projects,
  (SELECT COUNT(*) FROM public.project_members
     WHERE project_id::text LIKE '33333333-%')        AS project_members;

\echo
\echo '════════════════════════════════════════════════════════════════════'
\echo ' Migration 079 verification — done. Paste the above output back.'
\echo '════════════════════════════════════════════════════════════════════'
