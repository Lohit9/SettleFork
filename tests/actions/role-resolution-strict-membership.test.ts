// @vitest-environment node
//
// Source-level invariant tests for `lib/actions/role-resolution.ts` after
// migration 079.
//
// PR 1 of project-level RBAC removed the org-role fallback that previously
// let `getUserProjectRole` resolve project access via `org_memberships.role`
// when no `project_members` row existed. Post-079, project access is
// determined ONLY by `project_members` membership (auto-granted at the
// event boundaries — invite acceptance, project creation, owner promotion,
// JIT — and never via fallback at read time).
//
// Source-level pinning here catches the most likely regression: a future
// "polite refactor" that re-introduces the fallback to "be permissive."
// The runtime equivalent (NULL when no row exists) is covered end-to-end
// by `tests/integration/project-rbac-strict-membership.test.ts`.
//
// Invariants pinned by this file:
//   P1.  `getUserProjectRole` queries `project_members` and only
//        `project_members` (no second SELECT against `org_memberships` or
//        `projects.org_id` for fallback purposes).
//   P2.  Return type is `ProjectRole | null`, not `OrgRole | null`.
//   P3.  `checkProjectPermission` uses `PROJECT_ROLE_HIERARCHY` (the
//        post-079 type-correct hierarchy), not the legacy `ROLE_HIERARCHY`.
//   P4.  `requireProjectPermission` parameters use `ProjectRole`.
//   P5.  No import of `ROLE_HIERARCHY` (deleted from
//        lib/types/organizations.ts as part of 079).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(__dirname, '../../lib/actions/role-resolution.ts'),
  'utf8'
)

describe('role-resolution.ts post-079', () => {
  it('P1 — getUserProjectRole queries project_members only (no org_memberships or projects fallback)', () => {
    // Locate the function body
    const fnStart = SRC.indexOf('export async function getUserProjectRole')
    expect(fnStart).toBeGreaterThanOrEqual(0)
    const fnEnd = SRC.indexOf('\n}\n', fnStart)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = SRC.slice(fnStart, fnEnd)

    // Must SELECT from project_members
    expect(body).toMatch(/\.from\(\s*['"]project_members['"]\s*\)/)

    // Must NOT SELECT from org_memberships (the legacy fallback table)
    expect(body).not.toMatch(/\.from\(\s*['"]org_memberships['"]\s*\)/)

    // Must NOT SELECT from projects (the legacy intermediate to find
    // org_id for fallback). The original implementation chained two
    // queries — one for project_members (primary), then one for
    // projects.org_id, then one for org_memberships.role.
    expect(body).not.toMatch(/\.from\(\s*['"]projects['"]\s*\)[\s\S]*\.select\(\s*['"]org_id['"]/)
  })

  it('P2 — return type is Promise<ProjectRole | null> (not OrgRole | null)', () => {
    const fnDecl = SRC.match(
      /export async function getUserProjectRole\([\s\S]*?\):\s*Promise<([^>]+)>/
    )
    expect(fnDecl).not.toBeNull()
    const ret = fnDecl![1].replace(/\s+/g, '')
    expect(ret).toBe('ProjectRole|null')
  })

  it('P3 — uses PROJECT_ROLE_HIERARCHY (not legacy ROLE_HIERARCHY)', () => {
    expect(SRC).toMatch(/PROJECT_ROLE_HIERARCHY/)
    // Word-boundary match so `PROJECT_ROLE_HIERARCHY` doesn't trigger this.
    expect(SRC).not.toMatch(/(?<![A-Z_])ROLE_HIERARCHY/)
  })

  it('P4 — checkProjectPermission and requireProjectPermission parameter type is ProjectRole', () => {
    const checkSig = SRC.match(
      /export async function checkProjectPermission\([\s\S]*?\):\s*Promise/
    )
    expect(checkSig).not.toBeNull()
    expect(checkSig![0]).toMatch(/minRole:\s*ProjectRole/)

    const requireSig = SRC.match(
      /export async function requireProjectPermission\([\s\S]*?\):\s*Promise/
    )
    expect(requireSig).not.toBeNull()
    expect(requireSig![0]).toMatch(/minRole:\s*ProjectRole/)
  })

  it('P5 — does not import the legacy ROLE_HIERARCHY symbol', () => {
    const imports = SRC.match(
      /import\s+\{[^}]*\}\s+from\s+['"]@\/lib\/types\/organizations['"]/g
    )
    expect(imports).not.toBeNull()
    for (const line of imports!) {
      expect(line).not.toMatch(/\bROLE_HIERARCHY\b/)
    }
  })
})
