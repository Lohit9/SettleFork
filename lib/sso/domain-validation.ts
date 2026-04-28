// Shared SSO validation primitives — single source of truth used by
// both the platform-admin actions in `lib/actions/sso.ts` and the
// org-admin actions in `lib/actions/sso-admin-mutations.ts`. Extracted
// in B-2-c-ii so a future regex / mode-list change updates both paths
// atomically rather than drifting silently.
//
// IMPORTANT: keep the regex byte-identical to the source from B-2-c-i
// (`lib/actions/sso.ts:65-66`). The platform-admin path's
// `addDomainAllowlist` was the original definition site; both paths
// must agree about what counts as a valid domain so a domain accepted
// by one is also accepted by the other.

import type { EnforcementMode } from '@/lib/types/organizations'

// ─── Regex + length bounds ────────────────────────────────────────────
//
// The regex enforces:
//   - Lowercase ASCII only (callers normalize via `.toLowerCase()`
//     first; the regex acts as a defense-in-depth guard against
//     Unicode / IDN inputs that bypass the normalization).
//   - 1–63 chars per label (`[a-z0-9-]{0,61}[a-z0-9]` middle plus the
//     leading char gives 1..63; matches the DNS label length limit).
//   - Labels can't start or end with a hyphen.
//   - At least two labels (the `(?:\.…)+` is `+`, not `*`) — so
//     `localhost` is rejected, `acme.com` accepted.
//
// The DB CHECK constraint at `supabase/migrations/070_sso.sql:153-158`
// enforces a looser version (lowercase, no `[@ ]`, length 1–253).
// This regex is the stricter app-layer guard; both must hold.

export const DOMAIN_REGEX =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export const DOMAIN_MIN_LENGTH = 1
export const DOMAIN_MAX_LENGTH = 253

// ─── Enforcement-mode list ────────────────────────────────────────────
//
// The DB CHECK constraint at `supabase/migrations/070_sso.sql:91-92`
// pins the same three values; this constant mirrors it for client-side
// validation. If the DB constraint widens (e.g. an "off" mode), update
// both sides — the migration AND this constant.

export const VALID_ENFORCEMENT_MODES: readonly EnforcementMode[] = [
  'strict',
  'hybrid',
  'optional',
] as const

// Re-export the canonical type so callers can import everything they
// need (`{ validateDomain, VALID_ENFORCEMENT_MODES, type EnforcementMode }`)
// from this single module. The underlying definition still lives in
// `@/lib/types/organizations`.
export type { EnforcementMode }

// ─── Validation helper ────────────────────────────────────────────────

/**
 * Normalize and validate a domain string for the SSO allowlist.
 *
 * Returns the normalized (trimmed, lowercased) domain on success, or a
 * structured error with a user-facing message on failure. Callers
 * should use the returned `domain` for the DB write — never the
 * caller's original input — to maintain the invariant that all stored
 * domains are normalized.
 *
 * Note: this function does NOT consult the DB. It only enforces the
 * shape of the input. Per-org "already added" and cross-org
 * "DOMAIN_ALREADY_MAPPED" checks live in the calling action.
 */
export function validateDomain(
  input: string,
): { ok: true; domain: string } | { ok: false; error: string } {
  const normalized = input.trim().toLowerCase()

  if (
    normalized.length < DOMAIN_MIN_LENGTH ||
    normalized.length > DOMAIN_MAX_LENGTH
  ) {
    return {
      ok: false,
      error: `Domain must be ${DOMAIN_MIN_LENGTH}–${DOMAIN_MAX_LENGTH} characters`,
    }
  }

  if (!DOMAIN_REGEX.test(normalized)) {
    return { ok: false, error: 'Domain format is invalid' }
  }

  // TODO: free-provider warning UX (B-2-c follow-up). For now, no
  // public-provider block-list — `gmail.com` is the SSO test fixture
  // domain (see `scripts/sso-test-setup.ts:50`). A future commit may
  // surface a soft warning ("This looks like a personal-email domain
  // — make sure your IdP is set up to authenticate it") on the
  // org-admin add-domain UI without changing this validator's
  // accept/reject contract.

  return { ok: true, domain: normalized }
}
