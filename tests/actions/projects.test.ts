// @vitest-environment node
//
// Source-level invariant tests for `createProject` in
// `lib/actions/projects.ts`.
//
// Why source-level (not a runtime Supabase mock):
//   The established pattern across `tests/actions/` (see
//   `bulk-approve.test.ts`, `unacknowledge-field.test.ts`,
//   `edit-mapping-sources.test.ts`, etc.) is `readFileSync` + regex
//   against the action source. The convention catches architectural
//   drift (missing fields in insert payloads, wrong scope filters,
//   missing auth gates) without needing to mock the Supabase fluent
//   builder. End-to-end runtime behavior is pinned by Heritage
//   integration tests under `tests/integration/`. We follow the same
//   convention here for consistency.
//
// Invariant pinned by this file:
//
//   P1.  `createProject`'s insert payload to `public.projects`
//        includes `use_mapping_redesign: true`. This is the code-side
//        half of the Path γ rollout (migration 078 flips the schema
//        default; this insert makes the new-project default explicit
//        at the call site so future creation paths that follow the
//        same partial-insert pattern cannot silently regress).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTIONS_PATH = resolve(__dirname, '../../lib/actions/projects.ts')
const SRC = readFileSync(ACTIONS_PATH, 'utf8')

function sliceFromTo(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

const CREATE_START = 'export async function createProject('
const CREATE_END = 'export async function getProjects('

const CREATE_BODY = sliceFromTo(SRC, CREATE_START, CREATE_END)

// ─────────────────────────────────────────────────────────────────────
// P1 — insert payload includes use_mapping_redesign: true
// ─────────────────────────────────────────────────────────────────────

describe('[createProject] insert payload', () => {
  it('writes to .from(\'projects\').insert({...}) (precondition for P1)', () => {
    expect(CREATE_BODY).toMatch(/\.from\(\s*['"]projects['"]\s*\)/)
    expect(CREATE_BODY).toMatch(/\.insert\(\s*\{[\s\S]*?\}\s*\)/)
  })

  it('inserts use_mapping_redesign: true so new projects opt into the redesigned mapping UI by default', () => {
    // Pin the literal key/value pair inside the projects insert call.
    // The slice is scoped from `.from('projects').insert(` to its
    // matching `})` so other inserts in the function (project_members,
    // datasets) cannot satisfy this regex.
    const insertStart = CREATE_BODY.indexOf(".from('projects')")
    expect(insertStart).toBeGreaterThanOrEqual(0)
    const insertOpen = CREATE_BODY.indexOf('.insert({', insertStart)
    expect(insertOpen).toBeGreaterThanOrEqual(0)
    const insertClose = CREATE_BODY.indexOf('})', insertOpen)
    expect(insertClose).toBeGreaterThan(insertOpen)
    const projectsInsertSlice = CREATE_BODY.slice(insertOpen, insertClose)
    expect(projectsInsertSlice).toMatch(/use_mapping_redesign\s*:\s*true\b/)
  })

  it('does NOT set use_mapping_redesign to false or any non-true literal in the projects insert', () => {
    // Regression guard: a future edit that tries to "make the default
    // explicit" by writing `false` would defeat the whole rollout.
    const insertStart = CREATE_BODY.indexOf(".from('projects')")
    const insertOpen = CREATE_BODY.indexOf('.insert({', insertStart)
    const insertClose = CREATE_BODY.indexOf('})', insertOpen)
    const projectsInsertSlice = CREATE_BODY.slice(insertOpen, insertClose)
    expect(projectsInsertSlice).not.toMatch(/use_mapping_redesign\s*:\s*false\b/)
    expect(projectsInsertSlice).not.toMatch(/use_mapping_redesign\s*:\s*null\b/)
  })
})
