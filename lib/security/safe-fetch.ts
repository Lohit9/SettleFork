// SSRF-defended HTTP client used by the SAML metadata-by-URL flow. The
// caller hands us a URL the org admin pasted; we hand back the bytes
// only if the URL meets every layer of our defense:
//
//   1. Protocol must be https:.
//   2. URL must have a hostname and no userinfo.
//   3. Hostname must resolve via DNS to at least one address.
//   4. Every resolved address must be public (not RFC 1918, not
//      loopback, not link-local, not multicast, not IPv6 ULA, etc).
//      See `lib/security/private-ip.ts` for the full block-list.
//   5. The HTTP request connects to one of the pre-validated public
//      IPs — even if DNS rebinds between resolution and connect, the
//      kernel-level socket connects to the IP we chose, not whatever
//      the OS resolver returns mid-request.
//   6. Each redirect re-runs steps 1..5 on the new URL.
//   7. Response is bounded by max bytes, max time, and TLS verification
//      remains mandatory throughout.
//
// Implementation choice: we use `undici`'s Agent with a custom
// `connect.lookup` instead of the simpler "rewrite the URL to use the
// raw IP and override the Host: header" pattern. Reasoning: TLS cert
// validation must succeed against the *original* hostname (cert SAN)
// for any real public IdP, but if we connect to a URL like
// `https://1.2.3.4/path` the SNI/server-identity check fails. Routing
// the connect via a custom lookup keeps SNI + Host derived from the
// original hostname (so TLS verifies correctly) while pinning the
// underlying TCP socket to our pre-validated IP. This is the canonical
// Node/undici pattern for DNS rebinding defense.
//
// References:
//   - undici Agent docs: https://undici.nodejs.org/#/docs/api/Agent
//   - SSRF cheat sheet: OWASP "Server Side Request Forgery Prevention"
//   - DNS rebinding mitigation: connect by IP after lookup, not by name

import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent, fetch as undiciFetch } from 'undici'
import { isPrivateOrSpecialIP } from './private-ip'

export interface SafeFetchOptions {
  /** Hard cap on bytes consumed from the response body. Default 1 MB. */
  maxBytes?: number
  /** Per-attempt timeout (applied per redirect hop). Default 10 s. */
  timeoutMs?: number
  /** Maximum redirect hops before giving up. Default 3. */
  maxRedirects?: number
  /** User-Agent header sent to the upstream. */
  userAgent?: string
  /**
   * Optional injected DNS lookup function — used by tests to deterministically
   * exercise the SSRF defenses without hitting real DNS. The signature matches
   * `node:dns/promises.lookup` with `{ all: true, verbatim: true }`.
   *
   * Production callers should leave this undefined to use the real resolver.
   */
  resolver?: (hostname: string) => Promise<readonly LookupAddress[]>
  /**
   * Optional injected fetch implementation — used by tests to mock the
   * outbound HTTP call independently of the DNS lookup. Production callers
   * should leave this undefined to use undici via a freshly-built Agent.
   *
   * Typed loosely as `Function` so callers can pass either the global
   * Web `fetch` or undici's `fetch` (their `Request`/`Headers` types
   * have minor structural differences that aren't relevant here).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchImpl?: (...args: any[]) => Promise<Response>
}

export interface LookupAddress {
  address: string
  family: 4 | 6
}

export type SafeFetchResult =
  | {
      ok: true
      bytes: Buffer
      contentType: string | null
      finalUrl: string
    }
  | {
      ok: false
      error: string
      errorCode:
        | 'INVALID_URL'
        | 'NON_HTTPS'
        | 'PRIVATE_IP'
        | 'DNS_FAILED'
        | 'TIMEOUT'
        | 'TOO_LARGE'
        | 'BAD_STATUS'
        | 'TOO_MANY_REDIRECTS'
    }

const DEFAULT_MAX_BYTES = 1_000_000
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_REDIRECTS = 3
const DEFAULT_USER_AGENT = 'Settle-MetadataFetcher/1.0'

/**
 * Fetch a URL with comprehensive SSRF defenses.
 *
 * Designed for fetching SAML 2.0 IdP metadata documents from public
 * endpoints. Returns either the response bytes (with a content-type and
 * the final URL after following redirects) or a typed error code.
 *
 * The success branch's `bytes` is bounded by `maxBytes` (default 1 MB)
 * and the body is consumed eagerly into a buffer — callers don't need
 * to remember to drain a stream.
 */
export async function safeFetchMetadata(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
  const resolve = opts.resolver ?? defaultResolver
  const httpImpl = (opts.fetchImpl ?? undiciFetch) as (
    url: string,
    init: Parameters<typeof undiciFetch>[1],
  ) => Promise<Response>

  let currentUrl = url
  let redirectCount = 0

  // Loop body covers the original request plus up to `maxRedirects`
  // follow-ups; we explicitly check the cap before issuing each fetch.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const validated = validateUrlShape(currentUrl)
    if (!validated.ok) return validated

    const { parsed } = validated

    // Step 3..4: DNS resolution + private/special IP rejection. We
    // resolve once here, hold the result, and pass it to the agent's
    // connect.lookup so the actual TCP connection cannot use a
    // different (rebinded) IP.
    let addresses: readonly LookupAddress[]
    try {
      addresses = await resolve(parsed.hostname)
    } catch {
      return {
        ok: false,
        error: 'DNS resolution failed',
        errorCode: 'DNS_FAILED',
      }
    }

    if (addresses.length === 0) {
      return {
        ok: false,
        error: 'DNS resolution returned no addresses',
        errorCode: 'DNS_FAILED',
      }
    }

    // Reject if ANY resolved IP is private/special. We could allow
    // mixed results and pick a public one, but rejecting on any private
    // IP is a tighter contract: it surfaces dual-homed misconfigurations
    // at the IdP rather than papering over them, and it removes any
    // ambiguity about which address the request actually used.
    for (const addr of addresses) {
      if (isPrivateOrSpecialIP(addr.address)) {
        return {
          ok: false,
          error:
            'URL resolves to a private or special-use IP address — SSRF prevention',
          errorCode: 'PRIVATE_IP',
        }
      }
    }

    // Pin to the first public IP. Using `connect.lookup` keeps SNI and
    // the Host: header derived from the original hostname, which is
    // required for TLS certificate validation against the cert's SAN.
    const pinned = addresses[0]!
    const agent = new Agent({
      connect: {
        lookup: (
          _hostname: string,
          _options: unknown,
          cb: (
            err: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void,
        ) => {
          cb(null, pinned.address, pinned.family)
        },
      },
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await httpImpl(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          Accept:
            'application/xml, text/xml, application/samlmetadata+xml, */*',
        },
        redirect: 'manual',
        signal: controller.signal,
        // The custom dispatcher pins the TCP connection to `pinned.address`;
        // TLS verification still happens against the original hostname.
        dispatcher: agent,
      })
    } catch (err) {
      clearTimeout(timer)
      // Best-effort cleanup; ignore close errors.
      void agent.close().catch(() => {})

      if (
        err instanceof Error &&
        (err.name === 'AbortError' ||
          // Some undici variants emit DOMException-like objects.
          (err as { code?: string }).code === 'UND_ERR_ABORTED')
      ) {
        return {
          ok: false,
          error: 'Request timed out',
          errorCode: 'TIMEOUT',
        }
      }
      return {
        ok: false,
        error: `Fetch failed: ${err instanceof Error ? err.message : 'unknown'}`,
        errorCode: 'BAD_STATUS',
      }
    }
    clearTimeout(timer)

    // Manual redirect handling so each hop is re-validated end-to-end
    // (DNS, IP, protocol). A single allow-then-rebind to a private IP
    // would otherwise sneak through if we delegated redirect logic to
    // undici with `redirect: 'follow'`.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      // Drain to free the connection.
      try {
        await response.body?.cancel()
      } catch {
        // ignore
      }
      void agent.close().catch(() => {})

      if (!location) {
        return {
          ok: false,
          error: 'Redirect response missing Location header',
          errorCode: 'BAD_STATUS',
        }
      }

      redirectCount++
      if (redirectCount > maxRedirects) {
        return {
          ok: false,
          error: `Too many redirects (>${maxRedirects})`,
          errorCode: 'TOO_MANY_REDIRECTS',
        }
      }

      try {
        currentUrl = new URL(location, currentUrl).toString()
      } catch {
        return {
          ok: false,
          error: 'Redirect Location is not a valid URL',
          errorCode: 'INVALID_URL',
        }
      }
      continue
    }

    if (response.status < 200 || response.status >= 300) {
      try {
        await response.body?.cancel()
      } catch {
        // ignore
      }
      void agent.close().catch(() => {})
      return {
        ok: false,
        error: `HTTP ${response.status}`,
        errorCode: 'BAD_STATUS',
      }
    }

    // Stream body with size cap. We could buffer with `response.arrayBuffer()`
    // but that gives the server a free pass to send unlimited bytes before we
    // see the size; reading via the stream lets us cancel mid-flight.
    if (!response.body) {
      void agent.close().catch(() => {})
      return {
        ok: false,
        error: 'No response body',
        errorCode: 'BAD_STATUS',
      }
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.length
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel()
            } catch {
              // ignore
            }
            void agent.close().catch(() => {})
            return {
              ok: false,
              error: `Response body exceeds ${maxBytes} bytes`,
              errorCode: 'TOO_LARGE',
            }
          }
          chunks.push(value)
        }
      }
    } catch (err) {
      void agent.close().catch(() => {})
      if (
        err instanceof Error &&
        (err.name === 'AbortError' ||
          (err as { code?: string }).code === 'UND_ERR_ABORTED')
      ) {
        return {
          ok: false,
          error: 'Request timed out',
          errorCode: 'TIMEOUT',
        }
      }
      return {
        ok: false,
        error: 'Response body read failed',
        errorCode: 'BAD_STATUS',
      }
    }

    void agent.close().catch(() => {})

    return {
      ok: true,
      bytes: Buffer.concat(chunks),
      contentType: response.headers.get('content-type'),
      finalUrl: currentUrl,
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Default DNS resolver. Wraps `node:dns/promises.lookup` to return the
 * shape we use internally and to filter to IPv4/IPv6 results only.
 */
async function defaultResolver(
  hostname: string,
): Promise<readonly LookupAddress[]> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map((r) => ({
    address: r.address,
    family: r.family as 4 | 6,
  }))
}

type ValidatedUrl =
  | { ok: true; parsed: URL }
  | { ok: false; error: string; errorCode: 'INVALID_URL' | 'NON_HTTPS' }

/**
 * Step 1..2 of the defense: shape-check the URL before any DNS or
 * network I/O. Pure / synchronous; safe to call on caller-controlled
 * input as the very first thing.
 */
function validateUrlShape(input: string): ValidatedUrl {
  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, error: 'Invalid URL', errorCode: 'INVALID_URL' }
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Only https:// URLs are allowed',
      errorCode: 'NON_HTTPS',
    }
  }

  if (!parsed.hostname) {
    return {
      ok: false,
      error: 'URL hostname is required',
      errorCode: 'INVALID_URL',
    }
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      error: 'URLs with embedded credentials are not allowed',
      errorCode: 'INVALID_URL',
    }
  }

  return { ok: true, parsed }
}
