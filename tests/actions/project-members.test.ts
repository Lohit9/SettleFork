// @vitest-environment node
//
// Source-level invariant tests for the PR 2a project-member management
// server actions. Mirrors the testing pattern in
// `tests/actions/organizations-rbac.test.ts`: read the source file once,
// slice each function body, regex-assert that the critical behaviors
// (auth gate, permission gate, last-admin guard, activity-log emit,
// revalidation, table/RPC names) are wired correctly.
//
// These are intentionally "shape" tests — they don't run the actions
// against a database. End-to-end coverage lives at the manual smoke
// level in PR 2a; future PRs can layer in DB integration tests against
// the local supabase test harness if regressions warrant.
//
// Item 2.2 update: the enrichment-shape pins shifted from the inline
// 3-step pattern (supabaseAdmin profiles SELECT + getAuthEmailsByIds)
// to the canonical `enrichWithUserIdentity` helper invocation
// (lib/auth/users.ts). Behavior is unchanged; the helper wraps the
// same RPC + profiles SELECT internally. Pin shifted to lock the
// new architectural choice.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/project-members.ts'),
  'utf8'
)

function functionBody(start: string, fallbackEnd: string = '\n}\n\n'): string {
  const a = SRC.indexOf(start)
  if (a < 0) throw new Error(`function not found: ${start}`)
  let b = SRC.indexOf(fallbackEnd, a + start.length)
  // Last function in the file lacks a trailing blank line after `}`. Fall
  // back to a single `\n}` then to end-of-file so this helper survives the
  // module's final declaration.
  if (b < 0) b = SRC.indexOf('\n}\n', a + start.length)
  if (b < 0) b = SRC.length
  return SRC.slice(a, b)
}

const GET_PROJECT_MEMBERS = functionBody(
  'export async function getProjectMembers('
)
const ADD_PROJECT_MEMBER = functionBody(
  'export async function addProjectMember('
)
const REMOVE_PROJECT_MEMBER = functionBody(
  'export async function removeProjectMember('
)
const UPDATE_PROJECT_MEMBER_ROLE = functionBody(
  'export async function updateProjectMemberRole('
)
const GET_AVAILABLE_ORG_MEMBERS = functionBody(
  'export async function getOrgMembersAvailableForProject('
)

// ─── File-wide invariants ───────────────────────────────────────────────────

describe('project-members.ts — module-level invariants', () => {
  it("declares 'use server' at the top", () => {
    expect(SRC.trimStart().startsWith("'use server'")).toBe(true)
  })

  it('imports requireProjectPermission for permission gating', () => {
    expect(SRC).toMatch(
      /from\s+['"]@\/lib\/actions\/role-resolution['"]/
    )
    expect(SRC).toMatch(/requireProjectPermission/)
  })

  it('imports logActivity for the activity_log fanout', () => {
    expect(SRC).toMatch(
      /from\s+['"]@\/lib\/actions\/activity-log['"]/
    )
    expect(SRC).toMatch(/logActivity/)
  })

  it('imports enrichWithUserIdentity for the canonical user-identity enrichment helper', () => {
    expect(SRC).toMatch(
      /import\s+\{[^}]*\benrichWithUserIdentity\b[^}]*\}\s+from\s+['"]@\/lib\/auth\/users['"]/
    )
  })
})

// ─── 1. getProjectMembers ───────────────────────────────────────────────────

describe('getProjectMembers — list with name/email enrichment', () => {
  it("gates on requireProjectPermission(projectId, 'viewer')", () => {
    expect(GET_PROJECT_MEMBERS).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]viewer['"]\s*\)/
    )
  })

  it("SELECTs from project_members with .eq('project_id', projectId)", () => {
    expect(GET_PROJECT_MEMBERS).toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)/
    )
  })

  it('filters out NULL roles per the type comment', () => {
    expect(GET_PROJECT_MEMBERS).toMatch(
      /\.not\(\s*['"]role['"]\s*,\s*['"]is['"]\s*,\s*null\s*\)/
    )
  })

  it("enriches via enrichWithUserIdentity helper keyed on 'user_id'", () => {
    expect(GET_PROJECT_MEMBERS).toMatch(
      /enrichWithUserIdentity\([\s\S]*?,\s*['"]user_id['"]/
    )
  })
})

// ─── 2. addProjectMember ────────────────────────────────────────────────────

describe('addProjectMember — admin gate, org-membership check, conflict guard', () => {
  it("gates on requireProjectPermission(projectId, 'admin')", () => {
    expect(ADD_PROJECT_MEMBER).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]admin['"]\s*\)/
    )
  })

  it('reads project.org_id from the projects table', () => {
    expect(ADD_PROJECT_MEMBER).toMatch(
      /\.from\(\s*['"]projects['"]\s*\)[\s\S]*?\.select\(\s*['"]org_id['"]\s*\)/
    )
  })

  it('verifies target user is in the org via org_memberships SELECT', () => {
    expect(ADD_PROJECT_MEMBER).toMatch(
      /\.from\(\s*['"]org_memberships['"]\s*\)[\s\S]*?\.eq\(\s*['"]org_id['"]\s*,\s*project\.org_id\s*\)[\s\S]*?\.eq\(\s*['"]user_id['"]\s*,\s*userId\s*\)/
    )
  })

  it('returns the org-membership error message verbatim when target is not in org', () => {
    expect(ADD_PROJECT_MEMBER).toMatch(/User must be a member of this organization/)
  })

  it('returns "User already has access" on existing project_members row', () => {
    expect(ADD_PROJECT_MEMBER).toMatch(/User already has access/)
  })

  it('INSERTs into project_members with caller as assigned_by', () => {
    expect(ADD_PROJECT_MEMBER).toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.insert\(\s*\{[\s\S]*?project_id:\s*projectId[\s\S]*?user_id:\s*userId[\s\S]*?role[\s\S]*?assigned_by:\s*user\.id/
    )
  })

  it("emits 'project_member_added' to activity_log", () => {
    expect(ADD_PROJECT_MEMBER).toMatch(
      /logActivity\(\s*projectId\s*,\s*['"]project_member_added['"]/
    )
  })

  it('revalidates the settings path and the project layout', () => {
    expect(ADD_PROJECT_MEMBER).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}\/settings`\s*\)/
    )
    expect(ADD_PROJECT_MEMBER).toMatch(
      /revalidatePath\(\s*`\/app\/projects\/\$\{projectId\}`\s*,\s*['"]layout['"]\s*\)/
    )
  })
})

// ─── 3. removeProjectMember ─────────────────────────────────────────────────

describe('removeProjectMember — admin gate + last-admin guard', () => {
  it("gates on requireProjectPermission(projectId, 'admin')", () => {
    expect(REMOVE_PROJECT_MEMBER).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]admin['"]\s*\)/
    )
  })

  it('reads target row to capture previous_role for the activity log', () => {
    expect(REMOVE_PROJECT_MEMBER).toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.select\(\s*['"]role['"]\s*\)/
    )
  })

  it('runs a COUNT-only admin guard before deleting', () => {
    expect(REMOVE_PROJECT_MEMBER).toMatch(
      /previousRole\s*===\s*['"]admin['"][\s\S]*?count:\s*['"]exact['"][\s\S]*?head:\s*true[\s\S]*?\.eq\(\s*['"]role['"]\s*,\s*['"]admin['"]\s*\)/
    )
  })

  it('refuses with "Cannot remove the last admin from this project" when count <= 1', () => {
    expect(REMOVE_PROJECT_MEMBER).toMatch(
      /count\s*\?\?\s*0\s*\)\s*<=\s*1[\s\S]*?Cannot remove the last admin from this project/
    )
  })

  it('DELETEs from project_members with both eq filters', () => {
    expect(REMOVE_PROJECT_MEMBER).toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.delete\(\s*\)[\s\S]*?\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)[\s\S]*?\.eq\(\s*['"]user_id['"]\s*,\s*userId\s*\)/
    )
  })

  it("emits 'project_member_removed' to activity_log with previous_role", () => {
    expect(REMOVE_PROJECT_MEMBER).toMatch(
      /logActivity\([\s\S]*?['"]project_member_removed['"][\s\S]*?previous_role:\s*previousRole/
    )
  })

  it('documents the TOCTOU race condition in JSDoc', () => {
    // JSDoc lives above the function signature, so check against the whole
    // file. Pinning the documented trade-off so a silent removal of the
    // comment trips review.
    expect(SRC).toMatch(/RACE-CONDITION NOTE/)
  })
})

// ─── 4. updateProjectMemberRole ─────────────────────────────────────────────

describe('updateProjectMemberRole — admin gate + last-admin demote guard', () => {
  it("gates on requireProjectPermission(projectId, 'admin')", () => {
    expect(UPDATE_PROJECT_MEMBER_ROLE).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]admin['"]\s*\)/
    )
  })

  it('idempotent no-op when current === newRole', () => {
    expect(UPDATE_PROJECT_MEMBER_ROLE).toMatch(
      /currentRole\s*===\s*newRole[\s\S]*?return\s*\{\s*success:\s*true\s*\}/
    )
  })

  it('only fires the COUNT guard on demote-from-admin paths', () => {
    expect(UPDATE_PROJECT_MEMBER_ROLE).toMatch(
      /currentRole\s*===\s*['"]admin['"][\s\S]*?newRole\s*!==\s*['"]admin['"][\s\S]*?count:\s*['"]exact['"][\s\S]*?head:\s*true/
    )
  })

  it('refuses with "Cannot demote the last admin on this project" when count <= 1', () => {
    expect(UPDATE_PROJECT_MEMBER_ROLE).toMatch(
      /count\s*\?\?\s*0\s*\)\s*<=\s*1[\s\S]*?Cannot demote the last admin on this project/
    )
  })

  it('UPDATEs project_members.role with both eq filters', () => {
    expect(UPDATE_PROJECT_MEMBER_ROLE).toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.update\(\s*\{\s*role:\s*newRole\s*\}\s*\)[\s\S]*?\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)[\s\S]*?\.eq\(\s*['"]user_id['"]\s*,\s*userId\s*\)/
    )
  })

  it("emits 'project_member_role_changed' with from_role + to_role", () => {
    expect(UPDATE_PROJECT_MEMBER_ROLE).toMatch(
      /logActivity\([\s\S]*?['"]project_member_role_changed['"][\s\S]*?from_role:\s*currentRole[\s\S]*?to_role:\s*newRole/
    )
  })
})

// ─── 5. getOrgMembersAvailableForProject ────────────────────────────────────

describe('getOrgMembersAvailableForProject — picker pool', () => {
  it("gates on requireProjectPermission(projectId, 'admin') (picker is admin-only)", () => {
    expect(GET_AVAILABLE_ORG_MEMBERS).toMatch(
      /requireProjectPermission\(\s*projectId\s*,\s*['"]admin['"]\s*\)/
    )
  })

  it('reads existing project_members user_ids for the NOT IN filter', () => {
    expect(GET_AVAILABLE_ORG_MEMBERS).toMatch(
      /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.select\(\s*['"]user_id['"]\s*\)[\s\S]*?\.eq\(\s*['"]project_id['"]\s*,\s*projectId\s*\)/
    )
  })

  it("queries org_memberships with .eq('org_id', orgId) and excludes existing user_ids", () => {
    expect(GET_AVAILABLE_ORG_MEMBERS).toMatch(
      /\.from\(\s*['"]org_memberships['"]\s*\)[\s\S]*?\.eq\(\s*['"]org_id['"]\s*,\s*orgId\s*\)/
    )
    // Postgrest `not('user_id', 'in', '(...)')` is the canonical pattern; we
    // only exercise the "exists" path because the test reads source code.
    expect(GET_AVAILABLE_ORG_MEMBERS).toMatch(
      /\.not\(\s*['"]user_id['"]\s*,\s*['"]in['"]/
    )
  })

  it("enriches via enrichWithUserIdentity helper keyed on 'user_id'", () => {
    expect(GET_AVAILABLE_ORG_MEMBERS).toMatch(
      /enrichWithUserIdentity\([\s\S]*?,\s*['"]user_id['"]/
    )
  })
})
