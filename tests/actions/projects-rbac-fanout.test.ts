// @vitest-environment node
//
// Source-level invariant tests for the createProject auto-grant
// fanout introduced by migration 079 (project-level RBAC PR 1).
//
// Behavior changes vs pre-079 createProject:
//   - The pre-079 inline "viewer cannot create projects" gate is removed.
//     Post-079 the org_memberships role taxonomy is { owner, member }; both
//     can create projects.
//   - The creator's project_members row used to be inserted directly
//     with role='owner'. The 'owner' value is no longer in the
//     project_members.role CHECK; the creator now becomes 'admin'.
//   - The direct insert is replaced by the SECURITY DEFINER RPC
//     `grant_new_project_access(p_project_id, p_org_id, p_creator_id)`,
//     which inserts the creator + all org owners + all org members
//     (when toggle on) in one transactional shot. Direct inserts via the
//     SSR client would fail RLS post-079 because the creator does not
//     yet have an admin row to satisfy `user_has_project_role(...,'admin')`.
//
// Invariants pinned:
//   P1.  Old viewer-block string is gone.
//   P2.  Old direct project_members insert with role:'owner' is gone.
//   P3.  An RPC call to `grant_new_project_access` is present, with the
//        new project id + org id + creator id.

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

  it('P3 — calls supabase.rpc(\'grant_new_project_access\', {...}) with project / org / creator ids', () => {
    expect(BODY).toMatch(/\.rpc\(\s*['"]grant_new_project_access['"]/)
    // Argument shape is the contract with migration 079 §J.1. The test
    // fails if any of the three is renamed.
    expect(BODY).toMatch(/p_project_id\s*:\s*project\.id/)
    expect(BODY).toMatch(/p_org_id\s*:\s*resolvedOrgId/)
    expect(BODY).toMatch(/p_creator_id\s*:\s*user\.id/)
  })
})
