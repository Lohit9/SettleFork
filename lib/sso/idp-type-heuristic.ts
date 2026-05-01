// IdP-type classifier from SAML metadata's entityID and SSO URL. The
// result is used as a UX hint — it drives the brand icon in the admin
// UI, the copy on troubleshooting links, and the on-screen step-by-step
// instructions. It is never used as a security decision: the cert
// validation, signature checks, and metadata-shape checks are all
// independent of which IdP "type" we infer.
//
// `generic` is always a valid fallback. A misclassification (e.g. a
// vanity entityID for an Okta tenant that doesn't include `okta.com`)
// degrades the UI hint but does not weaken any security boundary.

import type { IdPType } from '@/lib/types/organizations'

// Re-export so callers can pull both the function and its return type
// from this module. The canonical definition still lives in
// `@/lib/types/organizations`.
export type { IdPType }

/**
 * Classify the IdP from entityID + (optional) SSO URL. Pure function.
 *
 * Heuristics, in priority order — first match wins:
 *   - Okta: hostname ends in okta.com / oktapreview.com / oktacloud.com
 *   - Entra (Azure AD): sts.windows.net, login.microsoftonline.com,
 *     login.windows.net
 *   - Google: accounts.google.com or google.com/sso/saml
 *   - Generic: anything else
 *
 * Note: matching is on substrings, not parsed hostnames. This is robust
 * against entityIDs that are URN-shaped (Okta historically used
 * `urn:okta:dev-12345`) where there is no parseable hostname. The
 * substrings are still specific enough to avoid collisions in practice.
 */
export function inferIdpType(
  entityId: string,
  ssoUrl: string | null | undefined,
): IdPType {
  const haystack = `${entityId} ${ssoUrl ?? ''}`.toLowerCase()

  if (/okta\.com|oktapreview\.com|oktacloud\.com/.test(haystack)) {
    return 'okta'
  }
  if (/sts\.windows\.net|login\.microsoftonline\.com|login\.windows\.net/.test(haystack)) {
    return 'entra'
  }
  if (/accounts\.google\.com|google\.com\/sso\/saml/.test(haystack)) {
    return 'google'
  }
  return 'generic'
}
