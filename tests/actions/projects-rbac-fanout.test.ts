// @vitest-environment node
//
// Source-level invariant tests for the createProject Server Action.
//
// Architecture (post-079 + post-080):
//   createProject is a thin caller of the SECURITY DEFINER RPC
//   `create_project_with_access` (migration 080). The RPC validates
//   auth.uid() once at entry, inserts the project row, fans out
//   project_members rows via grant_new_project_access (migration
//   079 §J.1), and inserts source + target datasets — all inside
//   one transaction.
//
// Pre-079 patterns guarded against:
//   - The inline "viewers cannot create projects" gate (org-role
//     'viewer' no longer exists post-079; both 'owner' and 'member'
//     can create projects).
//   - Direct insert into project_members with role='owner' (the
//     project_members.role CHECK no longer accepts 'owner'; creators
//     are 'admin').
//
// Pre-080 patterns guarded against:
//   - Direct call to grant_new_project_access from the Server Action
//     (now an internal step inside create_project_with_access).
//
// Invariants pinned:
//   P1.  Old viewer-block string is gone.
//   P2.  Old direct project_members insert with role:'owner' is gone.
//   P3.  An RPC call to `create_project_with_access` is present with
//        the migration-080 parameter shape, and the pre-080
//        grant_new_project_access pattern is gone.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/projects.ts'),
  'utf8'
)

function createProjectBody(): string {
  const start = SRC.indexOf('export async function createProject(')
  const end = SRC.indexOf('export async function getProjects(')
  if (start < 0 || end < 0) throw new Error('createProject function not located')
  return SRC.slice(start, end)
}

const BODY = createProjectBody()

describe('createProject — post-079 fanout invariants', () => {
  it('P1 — does not contain the legacy viewer-block guard', () => {
    expect(BODY).not.toMatch(/Viewers cannot create projects/i)
    // The pre-079 condition itself: `membership.role === 'viewer'`
    expect(BODY).not.toMatch(/membership\.role\s*===\s*['"]viewer['"]/)
  })

  it('P2 — does not insert into project_members with role:\'owner\' directly', () => {
    // The legacy direct insert: .from('project_members').insert({...role: 'owner'...})
    const directInsert = /\.from\(\s*['"]project_members['"]\s*\)[\s\S]*?\.insert\(\s*\{[^}]*role\s*:\s*['"]owner['"]/
    expect(BODY).not.toMatch(directInsert)
  })

  it('P3 — calls supabase.rpc(\'create_project_with_access\', {...}) with the 080 RPC parameter shape', () => {
    // Migration 080 replaced the in-action multi-step flow with a single
    // SECURITY DEFINER RPC that wraps the project insert, the
    // grant_new_project_access fanout, and the source/target dataset
    // inserts. createProject is now a thin caller of that RPC.
    expect(BODY).toMatch(/\.rpc\(\s*['"]create_project_with_access['"]/)

    // Parameter names are the contract with migration 080. The test
    // fails if any is renamed.
    expect(BODY).toMatch(/p_name\s*:\s*name/)
    expect(BODY).toMatch(/p_description\s*:\s*description/)
    expect(BODY).toMatch(/p_source_system_name\s*:\s*sourceSystemName/)
    expect(BODY).toMatch(/p_target_system_name\s*:\s*targetSystemName/)
    expect(BODY).toMatch(/p_org_id\s*:\s*orgId/)

    // Negative guard: the Server Action no longer calls
    // grant_new_project_access directly — that's now an internal call
    // site within the 080 RPC, covered by tests/migrations/
    // 079-project-rbac-strict-membership.test.ts §J.1 and the integration
    // test. Pinning this negative guards against a regression to the
    // pre-080 shape.
    expect(BODY).not.toMatch(/\.rpc\(\s*['"]grant_new_project_access['"]/)
  })
})
