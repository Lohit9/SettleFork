// @vitest-environment node
//
// Source-level invariant tests for the validation hardening shipped in
// PR C (feat(security): zod validation + archive guards on project
// mutation actions).
//
// Same source-level testing strategy as `tests/actions/projects.test.ts`
// and the broader `tests/actions/` convention (see `bulk-approve.test.ts`,
// `unacknowledge-field.test.ts`, `edit-mapping-sources.test.ts`): read
// the action source as a string and pin the contract via regex. Catches
// architectural drift without requiring a Supabase fixture; end-to-end
// runtime behavior is pinned by integration tests.
//
// Functions covered: updateProject, updateProjectLabels, markProjectComplete.
//
// Invariants:
//
//   M1.   zod is imported as a named binding (`import { z } from 'zod'`).
//   M2.   PROJECT_NAME_MAX_LENGTH = 120 (runtime import).
//   M3.   DATASET_LABEL_MAX_LENGTH = 80 (runtime import).
//   M4.   updateProjectInputSchema defined as z.object(...).
//   M5.   updateProjectLabelsInputSchema defined as z.object(...).
//
//   USP1. updateProject schema: name uses .trim() then .min(1) then .max(PROJECT_NAME_MAX_LENGTH).
//   USP2. updateProject schema: empty-name message is 'Project name cannot be empty'.
//   USP3. updateProject schema: over-cap message references the constant.
//
//   ULP1. updateProjectLabels schema: source label .trim().min(1).max(DATASET_LABEL_MAX_LENGTH).
//   ULP2. updateProjectLabels schema: target label .trim().min(1).max(DATASET_LABEL_MAX_LENGTH).
//   ULP3. updateProjectLabels schema: empty messages for both source and target.
//   ULP4. updateProjectLabels schema: max-length messages for both.
//
//   UPB1. updateProject body calls updateProjectInputSchema.safeParse.
//   UPB2. updateProject body has the archive guard fetch (status SELECT).
//   UPB3. updateProject returns 'Cannot modify archived project'.
//
//   ULBB1. updateProjectLabels body calls updateProjectLabelsInputSchema.safeParse.
//   ULBB2. updateProjectLabels body has archive guard fetch.
//   ULBB3. updateProjectLabels returns 'Cannot modify archived project'.
//
//   MPCB1. markProjectComplete fetches status before delegating to updateProject.
//   MPCB2. markProjectComplete returns 'Cannot mark archived project complete'.
//   MPCB3. markProjectComplete still calls updateProject (delegation precondition).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PROJECT_NAME_MAX_LENGTH,
  DATASET_LABEL_MAX_LENGTH,
} from '@/lib/actions/projects.constants'

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

const UPDATE_PROJECT_LABELS_BODY = sliceFromTo(
  SRC,
  'export async function updateProjectLabels(',
  'export async function createProject(',
)
const UPDATE_PROJECT_BODY = sliceFromTo(
  SRC,
  'export async function updateProject(',
  'export async function deleteProject(',
)
const MARK_PROJECT_COMPLETE_BODY = sliceFromTo(
  SRC,
  'export async function markProjectComplete(',
  'export async function reactivateProject(',
)

describe('[projects.ts] module-level Zod scaffolding', () => {
  it('M1 — imports zod as a named binding', () => {
    expect(SRC).toMatch(/import\s*\{\s*z\s*\}\s*from\s*['"]zod['"]/)
  })

  it('M2 — PROJECT_NAME_MAX_LENGTH is 120', () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(120)
  })

  it('M3 — DATASET_LABEL_MAX_LENGTH is 80', () => {
    expect(DATASET_LABEL_MAX_LENGTH).toBe(80)
  })

  it('M4 — updateProjectInputSchema defined as z.object(...)', () => {
    expect(SRC).toMatch(/const\s+updateProjectInputSchema\s*=\s*z\.object\(/)
  })

  it('M5 — updateProjectLabelsInputSchema defined as z.object(...)', () => {
    expect(SRC).toMatch(/const\s+updateProjectLabelsInputSchema\s*=\s*z\.object\(/)
  })
})

describe('[updateProject] schema invariants', () => {
  it('USP1 — name field uses .trim(), .min(1), and .max(PROJECT_NAME_MAX_LENGTH) in order', () => {
    expect(SRC).toMatch(
      /name:\s*z\s*[\s\S]*?\.string\(\)[\s\S]*?\.trim\(\)[\s\S]*?\.min\(\s*1[\s\S]*?\.max\(\s*PROJECT_NAME_MAX_LENGTH/,
    )
  })

  it('USP2 — empty-name message is "Project name cannot be empty"', () => {
    expect(SRC).toMatch(/['"]Project name cannot be empty['"]/)
  })

  it('USP3 — over-cap message references the constant via template literal', () => {
    expect(SRC).toMatch(/Project name must be \$\{PROJECT_NAME_MAX_LENGTH\} characters or less/)
  })
})

describe('[updateProjectLabels] schema invariants', () => {
  it('ULP1 — source label uses .trim().min(1).max(DATASET_LABEL_MAX_LENGTH)', () => {
    expect(SRC).toMatch(
      /sourceLabel:\s*z\s*[\s\S]*?\.string\(\)[\s\S]*?\.trim\(\)[\s\S]*?\.min\(\s*1[\s\S]*?\.max\(\s*DATASET_LABEL_MAX_LENGTH/,
    )
  })

  it('ULP2 — target label uses .trim().min(1).max(DATASET_LABEL_MAX_LENGTH)', () => {
    expect(SRC).toMatch(
      /targetLabel:\s*z\s*[\s\S]*?\.string\(\)[\s\S]*?\.trim\(\)[\s\S]*?\.min\(\s*1[\s\S]*?\.max\(\s*DATASET_LABEL_MAX_LENGTH/,
    )
  })

  it('ULP3 — empty messages for both source and target', () => {
    expect(SRC).toMatch(/['"]Source label cannot be empty['"]/)
    expect(SRC).toMatch(/['"]Target label cannot be empty['"]/)
  })

  it('ULP4 — max-length messages for both source and target', () => {
    expect(SRC).toMatch(/Source label must be \$\{DATASET_LABEL_MAX_LENGTH\} characters or less/)
    expect(SRC).toMatch(/Target label must be \$\{DATASET_LABEL_MAX_LENGTH\} characters or less/)
  })
})

describe('[updateProject] function body — validation + archive guard', () => {
  it('UPB1 — calls updateProjectInputSchema.safeParse', () => {
    expect(UPDATE_PROJECT_BODY).toMatch(/updateProjectInputSchema\.safeParse/)
  })

  it('UPB2 — fetches projects.status before non-system writes', () => {
    expect(UPDATE_PROJECT_BODY).toMatch(
      /\.from\(\s*['"]projects['"]\s*\)[\s\S]*?\.select\(\s*['"]status['"]/,
    )
  })

  it('UPB3 — returns archive-blocked error message', () => {
    expect(UPDATE_PROJECT_BODY).toMatch(/['"]Cannot modify archived project['"]/)
  })
})

describe('[updateProjectLabels] function body — validation + archive guard', () => {
  it('ULBB1 — calls updateProjectLabelsInputSchema.safeParse', () => {
    expect(UPDATE_PROJECT_LABELS_BODY).toMatch(/updateProjectLabelsInputSchema\.safeParse/)
  })

  it('ULBB2 — fetches projects.status before write', () => {
    expect(UPDATE_PROJECT_LABELS_BODY).toMatch(
      /\.from\(\s*['"]projects['"]\s*\)[\s\S]*?\.select\(\s*['"]status['"]/,
    )
  })

  it('ULBB3 — returns archive-blocked error message', () => {
    expect(UPDATE_PROJECT_LABELS_BODY).toMatch(/['"]Cannot modify archived project['"]/)
  })
})

describe('[markProjectComplete] function body — explicit archive guard', () => {
  it('MPCB1 — fetches projects.status before delegating to updateProject', () => {
    expect(MARK_PROJECT_COMPLETE_BODY).toMatch(
      /\.from\(\s*['"]projects['"]\s*\)[\s\S]*?\.select\(\s*['"]status['"]/,
    )
  })

  it('MPCB2 — returns explicit message for archived project', () => {
    expect(MARK_PROJECT_COMPLETE_BODY).toMatch(
      /['"]Cannot mark archived project complete['"]/,
    )
  })

  it('MPCB3 — still calls updateProject (delegation preserved)', () => {
    expect(MARK_PROJECT_COMPLETE_BODY).toMatch(/updateProject\(\s*projectId/)
  })
})
