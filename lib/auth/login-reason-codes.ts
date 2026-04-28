/**
 * Single source of truth for login-page reason-code rendering.
 *
 * Every `?reason=…` and `?error=…` value any caller in the codebase
 * appends when redirecting to `/login` MUST be a key in `LOGIN_REASONS`
 * below. The source-level test
 * `tests/lib/auth/login-reason-codes-source.test.ts` enforces this in
 * both directions:
 *   - Every emitter's literal must map to a known `ReasonCode`.
 *   - Every `ReasonCode` must be emitted from at least one file.
 *
 * If you need to add a new reason code:
 *   1. Add it to the `ReasonCode` union below.
 *   2. Add an entry to `LOGIN_REASONS` with copy + severity.
 *   3. Update the EXPECTED_EMITTED_CODES allow-list in the source test
 *      so the test knows the new emitter is intentional.
 *   4. Update emitters (the route or component that adds it to a
 *      redirect URL) — the source test will fail until you do.
 *
 * Why a closed enum (not an open string): unknown codes are silently
 * ignored on the login page. That is intentional — a malicious crafter
 * cannot inject custom copy into the page by appending arbitrary
 * `?reason=…` strings. Adding a new code is an explicit, reviewed
 * change.
 */

export type ReasonCode =
  // Session timeout — emitted by the idle-watcher in the app shell.
  | 'timeout'
  // Strict-SSO enforcement: middleware signs the user out if their
  // session is password-backed but their org requires SSO.
  | 'sso_required'
  // SSO start route validations (`/sso/start`).
  | 'sso_bad_request'
  | 'sso_rate_limited'
  | 'sso_unavailable'
  | 'sso_unknown_org'
  | 'sso_not_configured'
  // SSO callback failures (`/api/auth/callback?type=sso`).
  | 'sso_callback_error'
  | 'sso_attempted_org_missing'
  | 'sso_cross_tenant'
  | 'sso_domain_mismatch'
  | 'sso_duplicate_account'
  | 'sso_jit_failed'
  // Generic auth-callback failure (uses `?error=` not `?reason=` —
  // the only code on the `error` channel today).
  | 'auth_callback_error'

export type ReasonSeverity = 'info' | 'error'

export interface ReasonCopy {
  /** User-facing one-sentence message rendered in the banner. */
  copy: string
  /**
   * Display severity. `info` renders as a default `<Alert>` (neutral),
   * `error` renders as `destructive`. There is no `success` mapping —
   * any user landing on `/login?reason=…` needs to act, never to
   * celebrate.
   */
  severity: ReasonSeverity
}

export const LOGIN_REASONS: Record<ReasonCode, ReasonCopy> = {
  timeout: {
    copy: 'Your session expired due to inactivity. Please sign in again.',
    severity: 'info',
  },
  sso_required: {
    copy: 'Your organization requires single sign-on. Use the SSO option to continue.',
    severity: 'info',
  },
  sso_bad_request: {
    copy: 'The SSO link you used was malformed. Please try signing in again.',
    severity: 'info',
  },
  sso_rate_limited: {
    copy: 'Too many SSO attempts from your network. Please wait a minute and try again.',
    severity: 'info',
  },
  sso_unavailable: {
    copy: "We couldn't reach your identity provider. Please try again, or contact support if the problem continues.",
    severity: 'error',
  },
  sso_unknown_org: {
    copy: "We couldn't find an organization with that SSO link. Check the link with your admin.",
    severity: 'info',
  },
  sso_not_configured: {
    copy: "Single sign-on isn't set up for that organization yet. Sign in with your email and password, or contact your admin.",
    severity: 'info',
  },
  sso_callback_error: {
    copy: "We couldn't complete sign-in via SSO. Please try again, or contact support if the problem continues.",
    severity: 'error',
  },
  sso_attempted_org_missing: {
    copy: 'Your SSO session expired. Please start the sign-in flow again.',
    severity: 'error',
  },
  sso_cross_tenant: {
    copy: 'The identity provider returned the wrong organization. Please start sign-in again, or contact your admin.',
    severity: 'error',
  },
  sso_domain_mismatch: {
    copy: 'Your identity provider issued a sign-in for a different organization than expected. Contact your admin.',
    severity: 'error',
  },
  sso_duplicate_account: {
    copy: 'An account with this email already exists. Please contact support to link your SSO identity.',
    severity: 'error',
  },
  sso_jit_failed: {
    copy: "We couldn't finish creating your account. Please try again, or contact support.",
    severity: 'error',
  },
  auth_callback_error: {
    copy: "We couldn't complete sign-in. Please try again, or request a new link.",
    severity: 'error',
  },
}

/**
 * Look up reason copy by code. Returns `null` for unknown codes —
 * callers should silently ignore unrecognized values rather than
 * rendering a generic "something went wrong". This prevents a
 * malicious URL crafter from injecting custom copy via
 * `?reason=<arbitrary-string>` and limits the page's surface area to
 * the explicitly-curated taxonomy above.
 *
 * Accepts `string | null` so the caller can pass
 * `searchParams.get('reason') ?? searchParams.get('error')` without
 * an extra null check.
 */
export function getReasonCopy(code: string | null | undefined): ReasonCopy | null {
  if (!code) return null
  if (Object.prototype.hasOwnProperty.call(LOGIN_REASONS, code)) {
    return LOGIN_REASONS[code as ReasonCode]
  }
  return null
}
