/**
 * Cloudflare Turnstile server-side verifier.
 *
 * Sits next to the other internal authorization helpers in lib/auth/ and
 * follows the same { ok, ... } result convention used by
 * requirePlatformAdmin (see RequirePlatformAdminResult). Never throws —
 * always returns a result the caller can pattern-match on so we can
 * keep public-form server actions on the existing `{ success, error }`
 * shape without try/catch ceremony.
 *
 * Behavior is intentionally fail-closed in production and friendly in
 * development:
 *
 *   - prod  + missing secret → { ok: false, reason: 'misconfigured' }
 *     so the form rejects rather than silently letting traffic through.
 *   - dev   + missing secret → { ok: true } with a one-shot warn so
 *     local development without Cloudflare credentials still works.
 *     The matching client widget renders a placeholder and emits a
 *     'dev-bypass-token'; either side independently bypasses, but the
 *     server is the actual security boundary.
 *
 * Verify endpoint:
 *   https://challenges.cloudflare.com/turnstile/v0/siteverify
 */

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const VERIFY_TIMEOUT_MS = 5_000

export type TurnstileVerifyResult =
  | { ok: true }
  | {
      ok: false
      reason: 'missing_token' | 'invalid_token' | 'network_error' | 'misconfigured'
      errorCodes?: string[]
    }

interface SiteverifyResponse {
  success: boolean
  'error-codes'?: string[]
  challenge_ts?: string
  hostname?: string
  action?: string
  cdata?: string
}

// One-shot warn so we don't spam logs every request when running locally
// without a Turnstile secret. Module-scoped state is fine here — the
// verifier is server-only and a process restart is the natural reset.
let devBypassWarned = false

function warnDevBypassOnce(): void {
  if (devBypassWarned) return
  devBypassWarned = true
  console.warn(
    '[turnstile] TURNSTILE_SECRET_KEY is not set — bypassing verification in development. ' +
      'Set it in .env.local to exercise the real flow.',
  )
}

export async function verifyTurnstileToken(
  token: string | null | undefined,
  remoteIp?: string,
): Promise<TurnstileVerifyResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  const isProduction = process.env.NODE_ENV === 'production'

  if (!secret) {
    if (!isProduction) {
      warnDevBypassOnce()
      return { ok: true }
    }
    console.error(
      '[turnstile] TURNSTILE_SECRET_KEY is not set in production. Rejecting submission.',
    )
    return { ok: false, reason: 'misconfigured' }
  }

  if (!token) {
    return { ok: false, reason: 'missing_token' }
  }

  const body = new URLSearchParams()
  body.set('secret', secret)
  body.set('response', token)
  if (remoteIp) body.set('remoteip', remoteIp)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    })
  } catch (err) {
    const isAbort =
      err instanceof DOMException && err.name === 'AbortError'
    return {
      ok: false,
      reason: 'network_error',
      errorCodes: [isAbort ? 'timeout' : 'fetch_failed'],
    }
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'network_error',
      errorCodes: [`http_${response.status}`],
    }
  }

  let data: SiteverifyResponse
  try {
    data = (await response.json()) as SiteverifyResponse
  } catch {
    return {
      ok: false,
      reason: 'network_error',
      errorCodes: ['invalid_json'],
    }
  }

  if (!data.success) {
    return {
      ok: false,
      reason: 'invalid_token',
      errorCodes: data['error-codes'] ?? [],
    }
  }

  return { ok: true }
}
