/**
 * Canonical safe-redirect / safe-path utilities.
 *
 * Centralizes the open-redirect + CRLF-injection validation that used
 * to live inline in `app/login/page.tsx` and `app/sso/start/route.ts`.
 * Two callers, two slightly different lookup conventions:
 *
 *   - Login page reads `?redirect=` (legacy emitter convention) with
 *     `?returnTo=` as a fallback (newer emitters such as
 *     `app/app/projects/[projectId]/layout.tsx:20`).
 *
 *   - /sso/start reads `?next=`.
 *
 * Both use the same validation rules. Rather than fork the rules into
 * two near-identical inline blocks, this module exposes:
 *
 *   - `isSafePath(s)` — pure predicate over a candidate string.
 *   - `getSafeNext(searchParams, { keys })` — reads the first present
 *     key from `searchParams`, runs the predicate, falls back to
 *     `/app/projects` on any rejection or miss.
 *
 * Validation rules — must match the prior inline logic at
 * `app/sso/start/route.ts:50-56`:
 *
 *   1. Candidate must start with `/`. Rejects absolute URLs
 *      (`https://evil.com`, `javascript:...`) and anything that isn't
 *      a same-origin path.
 *
 *   2. Candidate must NOT start with `//`. Blocks protocol-relative
 *      URLs (`//evil.com/whatever`) which the browser resolves to
 *      `https://evil.com/whatever` — a real open-redirect vector that
 *      `startsWith('/')` alone permits.
 *
 *   3. Candidate must NOT contain `\r` or `\n`. Blocks CRLF header
 *      injection if the value is later interpolated into a `Location:`
 *      header (Next's `redirect()` does exactly that).
 *
 * Fail-soft: any rejection falls through to the canonical post-login
 * landing page `/app/projects`. Never throws.
 */

const FALLBACK = '/app/projects'

const DEFAULT_LOGIN_KEYS = ['redirect', 'returnTo'] as const

/**
 * Pure predicate: is the given string a safe same-origin path?
 *
 * Returns `false` for null, undefined, empty string, anything not
 * starting with `/`, anything starting with `//`, or anything
 * containing `\r` / `\n`.
 *
 * Useful when the caller already has the candidate in hand (e.g.,
 * read from a non-standard query key, or from a request header) and
 * just wants the rule check.
 */
export function isSafePath(candidate: string | null | undefined): boolean {
  if (!candidate) return false
  if (!candidate.startsWith('/')) return false
  if (candidate.startsWith('//')) return false
  if (/[\r\n]/.test(candidate)) return false
  return true
}

export interface GetSafeNextOptions {
  /**
   * Ordered list of search-param keys to try. The first present
   * (truthy) value is validated; subsequent keys are not consulted —
   * we explicitly do NOT fall through to a later key when an earlier
   * one is present-but-malformed (silent fall-through could mask an
   * attacker-supplied bad value).
   *
   * Defaults to `['redirect', 'returnTo']` for the login page.
   * Pass `['next']` for `/sso/start`.
   */
  keys?: readonly string[]
}

/**
 * Resolve a safe redirect destination from URL search params.
 *
 * @param searchParams Anything with a `.get(key) => string | null`
 *   method. `URLSearchParams`, Next's `ReadonlyURLSearchParams`, or a
 *   minimal shim from a unit test all satisfy this shape.
 * @param options.keys Ordered list of param names to read (defaults
 *   to `['redirect', 'returnTo']`).
 * @returns A safe absolute path. Always starts with `/`, never `//`.
 *   Falls back to `/app/projects` on any rejection or miss.
 */
export function getSafeNext(
  searchParams: { get(key: string): string | null },
  options?: GetSafeNextOptions,
): string {
  const keys = options?.keys ?? DEFAULT_LOGIN_KEYS

  let candidate: string | null = null
  for (const key of keys) {
    const v = searchParams.get(key)
    if (v) {
      candidate = v
      break
    }
  }

  return isSafePath(candidate) ? (candidate as string) : FALLBACK
}
