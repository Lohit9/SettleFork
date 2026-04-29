// @vitest-environment node
//
// Source-level invariant tests for migration
// `supabase/migrations/079_project_rbac_strict_membership.sql`.
//
// SQL invariants here are pinned because the migration is the
// foundation of the entire project-level RBAC PR — a regression in
// any of these (e.g. forgetting to drop the org branch in
// user_can_access_project, or skipping the org_memberships UPDATE
// before tightening the CHECK constraint) would corrupt access
// behavior across the system.
//
// Behavioral correctness (RLS visibility, fanout idempotency, etc.)
// is covered by `tests/integration/project-rbac-strict-membership.test.ts`,
// which is env-gated and not part of the standard quality gate.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SQL = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/079_project_rbac_strict_membership.sql'
  ),
  'utf8'
)

describe('migration 079 — schema/data layer invariants', () => {
  it('§A — adds organizations.member_auto_grant_enabled with NOT NULL DEFAULT TRUE', () => {
    expect(SQL).toMatch(
      /ALTER\s+TABLE\s+public\.organizations[\s\S]+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+member_auto_grant_enabled\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+TRUE/i
    )
  })

  it('§B — UPDATEs org_memberships role values BEFORE tightening the CHECK constraint', () => {
    const updateIdx = SQL.search(
      /UPDATE\s+public\.org_memberships\s+SET\s+role\s*=\s*'owner'/i
    )
    const checkIdx = SQL.search(
      /ALTER\s+TABLE\s+public\.org_memberships[\s\S]+ADD\s+CONSTRAINT\s+org_memberships_role_check[\s\S]+CHECK\s*\(\s*role\s+IN\s*\(\s*'owner',\s*'member'\s*\)/i
    )
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    expect(checkIdx).toBeGreaterThan(updateIdx)
  })

  it('§B — UPDATEs org_invites the same way (admin→owner, editor/viewer→member)', () => {
    expect(SQL).toMatch(
      /UPDATE\s+public\.org_invites\s+SET\s+role\s*=\s*'owner'\s+WHERE\s+role\s*=\s*'admin'/i
    )
    expect(SQL).toMatch(
      /UPDATE\s+public\.org_invites\s+SET\s+role\s*=\s*'member'\s+WHERE\s+role\s+IN\s*\(\s*'editor',\s*'viewer'\s*\)/i
    )
  })

  it('§C — UPDATEs project_members owner→admin BEFORE tightening the CHECK constraint', () => {
    const updateIdx = SQL.search(
      /UPDATE\s+public\.project_members\s+SET\s+role\s*=\s*'admin'\s+WHERE\s+role\s*=\s*'owner'/i
    )
    const checkIdx = SQL.search(
      /ADD\s+CONSTRAINT\s+project_members_role_check[\s\S]+CHECK\s*\(\s*role\s+IN\s*\(\s*'admin',\s*'editor',\s*'viewer'\s*\)/i
    )
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    expect(checkIdx).toBeGreaterThan(updateIdx)
  })

  it('§D — get_user_admin_org_ids filters on role = \'owner\' only (no \'admin\')', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.get_user_admin_org_ids[\s\S]*?LANGUAGE\s+\w+/i
    )
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).toMatch(/role\s*=\s*'owner'/i)
    expect(fnMatch![0]).not.toMatch(/role\s+IN\s*\(\s*'owner',\s*'admin'\s*\)/i)
  })

  it('§E — backfills project-admin rows for org owners (cartesian (owners × org projects))', () => {
    expect(SQL).toMatch(
      /INSERT\s+INTO\s+public\.project_members[\s\S]+SELECT\s+p\.id,\s+om\.user_id,\s+'admin'[\s\S]+FROM\s+public\.org_memberships\s+om[\s\S]+JOIN\s+public\.projects\s+p\s+ON\s+p\.org_id\s*=\s*om\.org_id[\s\S]+WHERE\s+om\.role\s*=\s*'owner'[\s\S]+ON\s+CONFLICT\s*\(\s*project_id,\s*user_id\s*\)\s+DO\s+NOTHING/i
    )
  })

  it('§E — backfills project-editor rows for org members only when member_auto_grant_enabled = TRUE', () => {
    expect(SQL).toMatch(
      /SELECT\s+p\.id,\s+om\.user_id,\s+'editor'[\s\S]+WHERE\s+om\.role\s*=\s*'member'\s+AND\s+o\.member_auto_grant_enabled\s*=\s*TRUE[\s\S]+ON\s+CONFLICT\s*\(\s*project_id,\s*user_id\s*\)\s+DO\s+NOTHING/i
    )
  })

  it('§F — get_user_project_role queries project_members only (no org fallback)', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.get_user_project_role[\s\S]*?LANGUAGE\s+\w+/i
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch![0]
    expect(body).toMatch(/SELECT\s+role\s+FROM\s+public\.project_members/i)
    // Must not contain a COALESCE fallback to org_memberships
    expect(body).not.toMatch(/COALESCE/i)
    expect(body).not.toMatch(/org_memberships/i)
  })

  it('§G — user_can_access_project drops the org_memberships branch', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.user_can_access_project[\s\S]*?LANGUAGE\s+\w+/i
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch![0]
    expect(body).toMatch(/EXISTS[\s\S]+project_members\s+pm/i)
    // Must not OR-EXIST against org_memberships
    expect(body).not.toMatch(/org_memberships/i)
  })

  it('§H — user_has_project_role hierarchy is { admin:3, editor:2, viewer:1 } (no owner, no reviewer)', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.user_has_project_role[\s\S]*?LANGUAGE\s+\w+/i
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch![0]
    // Pin the canonical hierarchy literal
    expect(body).toMatch(
      /'\{\s*"admin"\s*:\s*3\s*,\s*"editor"\s*:\s*2\s*,\s*"viewer"\s*:\s*1\s*\}'::JSONB/i
    )
    // Defensive: no leftover 'owner' or 'reviewer' keys in the hierarchy
    expect(body).not.toMatch(/"owner"\s*:\s*\d/i)
    expect(body).not.toMatch(/"reviewer"\s*:\s*\d/i)
  })

  it('§I — projects SELECT RLS filters on project_members only (no org_id branch)', () => {
    const policyMatch = SQL.match(
      /CREATE\s+POLICY\s+"members_can_view_projects"\s+ON\s+public\.projects\s+FOR\s+SELECT[\s\S]*?;/i
    )
    expect(policyMatch).not.toBeNull()
    const body = policyMatch![0]
    expect(body).toMatch(/id\s+IN\s*\(\s*SELECT\s+project_id\s+FROM\s+public\.project_members/i)
    // Must not contain the legacy `org_id IN ...` branch.
    expect(body).not.toMatch(/org_id\s+IN/i)
  })

  it('§I — drops the legacy "org_members_can_view_projects" policy', () => {
    expect(SQL).toMatch(
      /DROP\s+POLICY\s+IF\s+EXISTS\s+"org_members_can_view_projects"\s+ON\s+public\.projects/i
    )
  })

  it('§J.1 — grant_new_project_access RPC inserts creator + owners + members (toggle-gated) with ON CONFLICT', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.grant_new_project_access[\s\S]*?\$\$;/i
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch![0]
    // Three INSERT statements
    expect((body.match(/INSERT\s+INTO\s+public\.project_members/gi) ?? []).length).toBe(3)
    // All three use ON CONFLICT DO NOTHING (stickiness)
    expect((body.match(/ON\s+CONFLICT\s*\(\s*project_id,\s*user_id\s*\)\s+DO\s+NOTHING/gi) ?? []).length).toBe(3)
    // Member fanout consults the toggle
    expect(body).toMatch(/o\.member_auto_grant_enabled\s*=\s*TRUE/i)
    // SECURITY DEFINER + search_path lockdown
    expect(body).toMatch(/SECURITY\s+DEFINER/i)
    expect(body).toMatch(/SET\s+search_path\s*=\s*public/i)
  })

  it('§J.2 — grant_new_org_member_project_access branches on p_role with ON CONFLICT', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.grant_new_org_member_project_access[\s\S]*?\$\$;/i
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch![0]
    expect(body).toMatch(/IF\s+p_role\s*=\s*'owner'\s+THEN/i)
    expect(body).toMatch(/ELSIF\s+p_role\s*=\s*'member'\s+THEN/i)
    expect((body.match(/ON\s+CONFLICT\s*\(\s*project_id,\s*user_id\s*\)\s+DO\s+NOTHING/gi) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('§J.3 — backfill_org_member_project_access does NOT consult the toggle (caller decides)', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.backfill_org_member_project_access[\s\S]*?\$\$;/i
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch![0]
    expect(body).toMatch(/INSERT\s+INTO\s+public\.project_members/i)
    expect(body).toMatch(/ON\s+CONFLICT\s*\(\s*project_id,\s*user_id\s*\)\s+DO\s+NOTHING/i)
    expect(body).not.toMatch(/member_auto_grant_enabled/i)
  })

  it('§K — provision_user_via_jit defaults to \'member\' (was \'viewer\') and calls fanout', () => {
    const fnMatch = SQL.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.provision_user_via_jit[\s\S]*?\$\$;/i
    )
    expect(fnMatch).not.toBeNull()
    const body = fnMatch![0]
    // The JIT branch (no invite found) must insert with role='member'
    expect(body).toMatch(/'member',\s*'jit'/i)
    // Must not insert with the legacy 'viewer' default
    expect(body).not.toMatch(/'viewer',\s*'jit'/i)
    // Must call the fanout helper
    expect(body).toMatch(/grant_new_org_member_project_access/i)
  })

  it('§L — verification block raises on residual legacy roles (fail-loud)', () => {
    expect(SQL).toMatch(
      /RAISE\s+EXCEPTION[\s\S]+org_memberships\s+rows\s+still\s+hold\s+legacy\s+roles/i
    )
    expect(SQL).toMatch(
      /RAISE\s+EXCEPTION[\s\S]+project_members\s+rows\s+still\s+hold\s+legacy\s+roles/i
    )
  })
})
