// @vitest-environment node
//
// Unit tests for `lib/sso/admin-metadata-upload-allowlist.ts`. Pins the
// truth table from Mini-D14 (session 2026-04-29):
//
//   ENABLED  ORGS              Result
//   false    anything          All disabled
//   unset    anything          All disabled
//   true     unset             All enabled
//   true     ''                All enabled (empty = no restriction)
//   true     'a,b,c'           Only orgs a, b, c enabled
//
// The helper is the load-bearing first-line gate for both
// `configureOrgSsoProviderFromXml` and `configureOrgSsoProviderFromUrl`.
// A regression here means a flag-off org could still reach the GoTrue
// path. We test both axes exhaustively, including the
// whitespace/empty-string edge cases that env-var-from-shell typically
// produces.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isMetadataUploadEnabledForOrg } from '@/lib/sso/admin-metadata-upload-allowlist'

const ORG_A = 'org-aaaa-aaaa-aaaa'
const ORG_B = 'org-bbbb-bbbb-bbbb'
const ORG_C = 'org-cccc-cccc-cccc'

beforeEach(() => {
  // Start every test with both env vars cleared so we never leak state
  // between cases. `vi.unstubAllEnvs` covers values set via `stubEnv`,
  // but we also explicitly delete to defeat any process-environment
  // leakage from `.env.local` loaded by the test setup file.
  vi.unstubAllEnvs()
  delete process.env.NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED
  delete process.env.SSO_ADMIN_METADATA_UPLOAD_ORGS
})

afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED
  delete process.env.SSO_ADMIN_METADATA_UPLOAD_ORGS
})

// ─────────────────────────────────────────────────────────────────────
// Master flag axis
// ─────────────────────────────────────────────────────────────────────

describe('master flag', () => {
  it('returns false when NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED is unset', () => {
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(false)
  })

  it('returns false when master flag is "false"', () => {
    vi.stubEnv('NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED', 'false')
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(false)
  })

  it('returns false when master flag is empty string', () => {
    vi.stubEnv('NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED', '')
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(false)
  })

  it('returns false when master flag is anything other than the literal "true"', () => {
    // Defensive: prevents an off-by-truthy regression where someone
    // accidentally swaps `=== 'true'` for the looser `Boolean(...)`.
    for (const v of ['1', 'yes', 'TRUE', 'True', ' true', 'true ']) {
      vi.stubEnv('NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED', v)
      expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(false)
    }
  })

  it('master flag false overrides any allowlist content', () => {
    vi.stubEnv('NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED', 'false')
    vi.stubEnv('SSO_ADMIN_METADATA_UPLOAD_ORGS', ORG_A)
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Per-org allowlist axis (master flag on)
// ─────────────────────────────────────────────────────────────────────

describe('per-org allowlist when master flag is on', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED', 'true')
  })

  it('returns true for any org when SSO_ADMIN_METADATA_UPLOAD_ORGS is unset', () => {
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(true)
    expect(isMetadataUploadEnabledForOrg(ORG_B)).toBe(true)
    expect(isMetadataUploadEnabledForOrg('')).toBe(true)
  })

  it('returns true for any org when allowlist is empty string', () => {
    vi.stubEnv('SSO_ADMIN_METADATA_UPLOAD_ORGS', '')
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(true)
  })

  it('returns true for any org when allowlist contains only whitespace/commas', () => {
    // After split/trim/filter, this collapses to an empty list. Per
    // Mini-D14 that means "no restriction" (operator probably typo'd
    // a quote-only value), so we open access — same as fully unset.
    vi.stubEnv('SSO_ADMIN_METADATA_UPLOAD_ORGS', '  ,  ,   ')
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(true)
  })

  it('returns true for orgs in the allowlist', () => {
    vi.stubEnv(
      'SSO_ADMIN_METADATA_UPLOAD_ORGS',
      `${ORG_A},${ORG_B}`,
    )
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(true)
    expect(isMetadataUploadEnabledForOrg(ORG_B)).toBe(true)
  })

  it('returns false for orgs not in the allowlist', () => {
    vi.stubEnv('SSO_ADMIN_METADATA_UPLOAD_ORGS', `${ORG_A},${ORG_B}`)
    expect(isMetadataUploadEnabledForOrg(ORG_C)).toBe(false)
  })

  it('trims whitespace around allowlist values (operator-friendly)', () => {
    vi.stubEnv(
      'SSO_ADMIN_METADATA_UPLOAD_ORGS',
      `  ${ORG_A}  ,${ORG_B}  ,  ${ORG_C}`,
    )
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(true)
    expect(isMetadataUploadEnabledForOrg(ORG_B)).toBe(true)
    expect(isMetadataUploadEnabledForOrg(ORG_C)).toBe(true)
  })

  it('does substring-equality, not substring-includes', () => {
    // Defense: a buggy `String.prototype.includes` implementation
    // would let `org-aa` match against an allowlist of `org-aaaa-...`.
    // The helper uses Array.includes on a split list, which does
    // strict equality.
    vi.stubEnv('SSO_ADMIN_METADATA_UPLOAD_ORGS', ORG_A)
    expect(isMetadataUploadEnabledForOrg('org-a')).toBe(false)
    expect(isMetadataUploadEnabledForOrg('org-aaaa')).toBe(false)
    expect(isMetadataUploadEnabledForOrg(ORG_A.slice(0, -1))).toBe(false)
  })

  it('handles a single-org allowlist correctly', () => {
    vi.stubEnv('SSO_ADMIN_METADATA_UPLOAD_ORGS', ORG_A)
    expect(isMetadataUploadEnabledForOrg(ORG_A)).toBe(true)
    expect(isMetadataUploadEnabledForOrg(ORG_B)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Synchronous shape (load-bearing for source-level invariant)
// ─────────────────────────────────────────────────────────────────────

describe('return type', () => {
  it('returns a boolean directly (not a Promise)', () => {
    vi.stubEnv('NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED', 'true')
    const result = isMetadataUploadEnabledForOrg(ORG_A)
    expect(typeof result).toBe('boolean')
    // Defense against a future refactor that makes the function async:
    // a Promise has a .then method; a primitive boolean does not.
    expect((result as unknown as { then?: unknown }).then).toBeUndefined()
  })
})
