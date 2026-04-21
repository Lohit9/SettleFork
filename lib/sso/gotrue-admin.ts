/**
 * GoTrue Admin REST API helper for Supabase SAML SSO operations.
 *
 * The Supabase JS SDK does NOT expose SAML provider CRUD. These
 * operations must hit the GoTrue Admin REST API directly using
 * the service role key.
 *
 * Security invariants:
 * - SUPABASE_SERVICE_ROLE_KEY is never included in Error
 *   messages, stack traces, or log output.
 * - All calls timeout after 15 seconds (abortable).
 * - Non-2xx responses raise an Error with status code and parsed
 *   error details — but never the auth header or the request
 *   body (which may contain SAML metadata XML or attribute maps).
 *
 * Used exclusively by lib/actions/sso.ts. Do not import from
 * browser-executing code.
 */

const GOTRUE_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const DEFAULT_TIMEOUT_MS = 15_000

export interface GoTrueError extends Error {
  status?: number
  gotrueCode?: string
}

export async function gotrueAdminRequest<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number }
): Promise<T> {
  const url = `${GOTRUE_BASE}${path}`
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })

    const text = await res.text()

    if (!res.ok) {
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = text
      }

      const p = (parsed ?? {}) as Record<string, unknown>
      const msg =
        (typeof p.msg === 'string' && p.msg) ||
        (typeof p.message === 'string' && p.message) ||
        (typeof p.error_description === 'string' && p.error_description) ||
        (typeof p.error === 'string' && p.error) ||
        `GoTrue ${method} ${path} failed with ${res.status}`
      const code =
        (typeof p.error_code === 'string' && p.error_code) ||
        (typeof p.code === 'string' && p.code) ||
        `http_${res.status}`

      console.error('[gotrue] request failed:', {
        method,
        path,
        status: res.status,
        gotrueCode: code,
        msg,
      })

      const err = new Error(
        `[gotrue] ${res.status} ${code}: ${msg}`
      ) as GoTrueError
      err.status = res.status
      err.gotrueCode = code
      throw err
    }

    if (!text) {
      return undefined as T
    }
    return JSON.parse(text) as T
  } finally {
    clearTimeout(timeout)
  }
}
