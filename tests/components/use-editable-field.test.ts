// @vitest-environment node
//
// Source-level invariant tests for PR F's useEditableField extraction.
//
// Same source-level testing strategy as
// tests/components/fix-history-identity.test.ts (PR #30) and
// tests/components/project-menu-radix.test.ts (PR #31). Read the
// component / hook source as a string and pin the contract via regex.
// Catches architectural drift without rendering.
//
// Positive invariants pin the hook's API contract + the two callsites'
// adoption. Negative invariants pin (a) the absence of toast / Zod /
// react-hook-form imports (the pattern is intentionally lightweight)
// and (b) the deliberate deferral of InfoTab (multi-field sequential
// save is a different abstraction; force the conversation if a future
// PR migrates it without thinking).
//
// Invariants:
//
//   EF1.  lib/hooks/useEditableField.ts exists and exports
//         useEditableField as a named function.
//   EF2.  Hook does NOT import zod, react-hook-form, sonner, or any
//         toast library (negative — pattern is intentionally light).
//   EF3.  Hook uses 'use client' directive at file top.
//   EF4.  Hook signature includes initialValue, onSave, alwaysEditing
//         options.
//   EF5.  Hook returns isEditing, draft, error, success, isSaving,
//         save, cancel in its return shape.
//   EF6.  ProfileCard imports useEditableField from
//         '@/lib/hooks/useEditableField'.
//   EF7.  ProfileCard does NOT contain a useState for the editing
//         toggle anymore (lifted into the hook).
//   EF8.  ProfileCard does NOT call setNameError anymore (error state
//         lifted).
//   EF9.  OrganizationSettingsContent imports useEditableField.
//   EF10. OrganizationSettingsContent does NOT contain an
//         orgNameSuccess useState anymore (success state lifted).
//   EF11. InfoTab does NOT import useEditableField — DELIBERATE
//         DEFERRAL. Multi-field sequential save is structurally
//         different. If a future PR tries to migrate InfoTab without
//         building useEditableFieldGroup first, this test fails and
//         forces the conversation.
//   EF12. CLAUDE.md mentions useEditableField (documentation present).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const HOOK_PATH = resolve(__dirname, '../../lib/hooks/useEditableField.ts')
const PROFILE_CARD_PATH = resolve(
  __dirname,
  '../../app/app/settings/ProfileCard.tsx',
)
const ORG_SETTINGS_PATH = resolve(
  __dirname,
  '../../app/app/settings/organization/OrganizationSettingsContent.tsx',
)
const INFO_TAB_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/settings/tabs/InfoTab.tsx',
)
const CLAUDE_MD_PATH = resolve(__dirname, '../../CLAUDE.md')

const HOOK_SRC = readFileSync(HOOK_PATH, 'utf8')
const PROFILE_CARD_SRC = readFileSync(PROFILE_CARD_PATH, 'utf8')
const ORG_SETTINGS_SRC = readFileSync(ORG_SETTINGS_PATH, 'utf8')
const INFO_TAB_SRC = readFileSync(INFO_TAB_PATH, 'utf8')
const CLAUDE_MD_SRC = readFileSync(CLAUDE_MD_PATH, 'utf8')

describe('[useEditableField] hook contract', () => {
  it('EF1 — exports useEditableField as a named function', () => {
    expect(HOOK_SRC).toMatch(/export\s+function\s+useEditableField\b/)
  })

  it('EF2 — does NOT import zod / react-hook-form / sonner (intentionally lightweight)', () => {
    expect(HOOK_SRC).not.toMatch(/from\s*['"]zod['"]/)
    expect(HOOK_SRC).not.toMatch(/from\s*['"]react-hook-form['"]/)
    expect(HOOK_SRC).not.toMatch(/from\s*['"]sonner['"]/)
    expect(HOOK_SRC).not.toMatch(/from\s*['"]react-hot-toast['"]/)
  })

  it('EF3 — uses "use client" directive at file top', () => {
    expect(HOOK_SRC.trimStart()).toMatch(/^['"]use client['"]/)
  })

  it('EF4 — options include initialValue, onSave, alwaysEditing', () => {
    // The options interface declares each member once on its own line
    expect(HOOK_SRC).toMatch(/\binitialValue\s*:\s*string/)
    expect(HOOK_SRC).toMatch(/\bonSave\s*:\s*\(/)
    expect(HOOK_SRC).toMatch(/\balwaysEditing\??\s*:\s*boolean/)
  })

  it('EF5 — return shape includes isEditing, draft, error, success, isSaving, save, cancel', () => {
    // The return object literal at the bottom of the hook lists each key
    for (const key of [
      'isEditing',
      'draft',
      'error',
      'success',
      'isSaving',
      'save',
      'cancel',
    ]) {
      expect(HOOK_SRC).toMatch(new RegExp(`\\b${key}\\b`))
    }
  })
})

describe('[ProfileCard] adopts useEditableField', () => {
  it('EF6 — imports useEditableField from @/lib/hooks/useEditableField', () => {
    expect(PROFILE_CARD_SRC).toMatch(
      /import\s*\{[^}]*\buseEditableField\b[^}]*\}\s*from\s*['"]@\/lib\/hooks\/useEditableField['"]/,
    )
  })

  it('EF7 — does NOT contain a useState for the editing toggle (lifted into the hook)', () => {
    // Negative: no isEditingName state declaration. The hook owns this.
    expect(PROFILE_CARD_SRC).not.toMatch(/useState[^)]*isEditingName/)
    expect(PROFILE_CARD_SRC).not.toMatch(/setIsEditingName\b/)
  })

  it('EF8 — does NOT call setNameError (error state lifted)', () => {
    expect(PROFILE_CARD_SRC).not.toMatch(/\bsetNameError\b/)
  })
})

describe('[OrganizationSettingsContent] adopts useEditableField', () => {
  it('EF9 — imports useEditableField from @/lib/hooks/useEditableField', () => {
    expect(ORG_SETTINGS_SRC).toMatch(
      /import\s*\{[^}]*\buseEditableField\b[^}]*\}\s*from\s*['"]@\/lib\/hooks\/useEditableField['"]/,
    )
  })

  it('EF10 — does NOT contain an orgNameSuccess useState (success state lifted)', () => {
    expect(ORG_SETTINGS_SRC).not.toMatch(/useState[^)]*orgNameSuccess/)
    expect(ORG_SETTINGS_SRC).not.toMatch(/\bsetOrgNameSuccess\b/)
  })
})

describe('[InfoTab] DEFERRED — multi-field sequential save is a different abstraction', () => {
  it('EF11 — InfoTab does NOT import useEditableField (locks the deferral)', () => {
    // Multi-field sequential save (project name + 2 dataset labels with
    // abort-on-first-failure semantics) is structurally different from the
    // single-field hook. When a 4th multi-field caller appears, factor a
    // separate useEditableFieldGroup hook with sequencing semantics built in.
    // If a future PR wires InfoTab to useEditableField without that work,
    // this test fails and forces the conversation.
    expect(INFO_TAB_SRC).not.toMatch(/\buseEditableField\b/)
  })
})

describe('[CLAUDE.md] documents useEditableField', () => {
  it('EF12 — at least one mention of useEditableField present', () => {
    expect(CLAUDE_MD_SRC).toMatch(/\buseEditableField\b/)
  })
})
