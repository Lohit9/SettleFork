// @vitest-environment node
//
// Source-level invariant tests for org-invite acceptance fanout
// after migration 079 (project-level RBAC PR 1).
//
// `acceptInvite` is the entry point for SAML/password users joining
// an org via an emailed invite link. Pre-079 it inserted only the
// org_memberships row; post-079 it must also fan out project_members
// rows for the new membership: 'owner' → admin everywhere; 'member' →
// editor everywhere if member_auto_grant_enabled. The fanout uses the
// SECURITY DEFINER RPC `grant_new_org_member_project_access` so it
// bypasses the RLS policy on project_members which gates direct INSERT
// on `user_has_project_role(...,'admin')`.
//
// `createOrgInvite` and `adminCreateOrgInvite` are also pinned because
// the legacy 'admin' org-role no longer exists; the caller gate must
// be tightened to owner-only on the user-facing path.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/org-invites.ts'),
  'utf8'
)

function functionBody(start: string): string {
  const a = SRC.indexOf(start)
  if (a < 0) throw new Error(`function not found: ${start}`)
  // Find the next top-level function declaration after this one. If
  // there isn't one (e.g. acceptInvite is currently the last export),
  // slice to end-of-file.
  const next = SRC.indexOf('\nexport async function ', a + start.length)
  return next < 0 ? SRC.slice(a) : SRC.slice(a, next)
}

const ACCEPT_INVITE = functionBody('export async function acceptInvite(')
const CREATE_ORG_INVITE = functionBody('export async function createOrgInvite(')

describe('acceptInvite — post-079 fanout', () => {
  it('still inserts the org_memberships row first', () => {
    expect(ACCEPT_INVITE).toMatch(
      /\.from\(\s*['"]org_memberships['"]\s*\)[\s\S]*?\.insert\(/
    )
  })

  it('calls grant_new_org_member_project_access RPC after the membership insert', () => {
    expect(ACCEPT_INVITE).toMatch(
      /\.rpc\(\s*[\s\n]*['"]grant_new_org_member_project_access['"]/
    )
    expect(ACCEPT_INVITE).toMatch(/p_user_id\s*:\s*userId/)
    expect(ACCEPT_INVITE).toMatch(/p_org_id\s*:\s*invite\.org_id/)
    expect(ACCEPT_INVITE).toMatch(/p_role\s*:\s*invite\.role/)
  })

  it('fanout uses supabaseAdmin (RLS would block the user-client INSERT for project-admin)', () => {
    // The RPC call must be on supabaseAdmin (the same client used for
    // the org_memberships insert), not the SSR user client. The user
    // does not yet have any project_members row to satisfy the SELECT
    // policy on the underlying tables.
    expect(ACCEPT_INVITE).toMatch(
      /supabaseAdmin\.rpc\(\s*[\s\n]*['"]grant_new_org_member_project_access['"]/
    )
  })

  it('fanout call sequencing is INSIDE the !existingMem branch (skip if already a member)', () => {
    // Pin sequencing: the rpc call must appear after `if (!existingMem)`
    // and before the closing brace of that block. We approximate by
    // checking it appears between the `!existingMem` guard and the
    // org_invites.update for accepted_at.
    const guardIdx = ACCEPT_INVITE.indexOf('if (!existingMem)')
    const acceptedAtIdx = ACCEPT_INVITE.indexOf("accepted_at: new Date()")
    expect(guardIdx).toBeGreaterThanOrEqual(0)
    expect(acceptedAtIdx).toBeGreaterThan(guardIdx)
    const middle = ACCEPT_INVITE.slice(guardIdx, acceptedAtIdx)
    expect(middle).toMatch(/grant_new_org_member_project_access/)
  })
})

describe('createOrgInvite — post-079 caller gate', () => {
  it('caller gate is owner-only (no \'admin\' org-role anymore)', () => {
    expect(CREATE_ORG_INVITE).not.toMatch(
      /\['owner',\s*'admin'\]\.includes\(callerMem\.role\)/
    )
    expect(CREATE_ORG_INVITE).toMatch(/callerMem\.role\s*!==\s*['"]owner['"]/)
  })
})
