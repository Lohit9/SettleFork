/**
 * Feature flag + per-org allowlist for the org-admin SAML metadata upload
 * surface (B-2-c-iii). Two-axis design:
 *
 *   - NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED: master kill switch.
 *     When 'false' or unset, ALL orgs are disabled regardless of allowlist.
 *
 *   - SSO_ADMIN_METADATA_UPLOAD_ORGS: per-org refinement (comma-separated
 *     org UUIDs). When unset or empty AND the master flag is on, ALL orgs
 *     are enabled. When non-empty AND the master flag is on, ONLY listed
 *     orgs are enabled.
 *
 * Truth table (Mini-D14):
 *   ENABLED  ORGS              Result
 *   false    anything          All disabled
 *   unset    anything          All disabled
 *   true     unset             All enabled
 *   true     ''                All enabled (empty = no restriction)
 *   true     'a,b,c'           Only orgs a, b, c enabled
 *
 * SYNCHRONOUS by design — must remain non-async so it can be called as
 * the FIRST textual statement in server actions without breaking the
 * source-level invariant from B-2-c-ii that
 * `requireOrgAdmin(orgId)` is the FIRST `await`. Any future async
 * variant (e.g. DB-backed allowlist) MUST add a separate function name
 * and update the source-level test in
 * `tests/actions/sso-admin-provider-config-source.test.ts` to reference
 * the new name explicitly.
 *
 * Why the master flag is `NEXT_PUBLIC_*` despite being read server-side:
 * the same flag value drives a UI affordance in commit 3 (the upload
 * card is hidden when the feature is off), so prefixing it with
 * `NEXT_PUBLIC_` lets us read it in both contexts from one source.
 * The per-org allowlist is server-only (no `NEXT_PUBLIC_`) because it
 * is operationally sensitive — knowing which orgs are in the pilot is
 * a tenancy-disclosure surface we don't want shipped to the browser
 * bundle.
 */
export function isMetadataUploadEnabledForOrg(orgId: string): boolean {
  if (process.env.NEXT_PUBLIC_SSO_ADMIN_METADATA_UPLOAD_ENABLED !== 'true') {
    return false
  }
  const allowlistRaw = process.env.SSO_ADMIN_METADATA_UPLOAD_ORGS
  if (!allowlistRaw) {
    return true
  }
  const allowlist = allowlistRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allowlist.length === 0) {
    return true
  }
  return allowlist.includes(orgId)
}
