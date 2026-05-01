// @vitest-environment node
//
// Coverage for `lib/security/safe-fetch.ts`. We exercise the SSRF
// defense layers (URL shape, DNS, private-IP block, redirect re-
// validation, response size cap, timeout) without making real network
// calls — the public API accepts injected `resolver` and `fetchImpl`
// hooks specifically so tests can drive every branch deterministically.
//
// The defenses are layered, so each test typically asserts ONE failure
// reason and ignores the layers below it. A single layer regression
// would surface as one specific test failing, not a cascade.

import { describe, it, expect, vi } from 'vitest'

import {
  safeFetchMetadata,
  type LookupAddress,
} from '@/lib/security/safe-fetch'

// ─── Test helpers ──────────────────────────────────────────────────────

/**
 * Build a deterministic resolver from a hostname → addresses map.
 * Throws (rejects) on hostnames not in the map, simulating NXDOMAIN.
 */
function fakeResolver(
  map: Record<string, readonly LookupAddress[]>,
): (hostname: string) => Promise<readonly LookupAddress[]> {
  return async (hostname: string) => {
    if (!(hostname in map)) {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    return map[hostname]!
  }
}

/**
 * Build a fake fetch that returns a sequence of canned Response objects
 * (one per call). When called more times than there are responses,
 * throws — surfacing test bugs where we expected to short-circuit.
 */
function sequencedFetch(
  ...responses: Array<{
    status: number
    headers?: Record<string, string>
    body?: string | Uint8Array
  }>
): typeof fetch {
  let i = 0
  return (async () => {
    const r = responses[i++]
    if (!r) throw new Error(`fetch called more than ${responses.length} times`)
    const body =
      r.body === undefined
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              if (typeof r.body === 'string') {
                controller.enqueue(new TextEncoder().encode(r.body))
              } else {
                controller.enqueue(r.body!)
              }
              controller.close()
            },
          })
    return new Response(body, {
      status: r.status,
      headers: r.headers,
    })
  }) as unknown as typeof fetch
}

// ─── URL shape (Layer 1..2) ────────────────────────────────────────────

describe('safeFetchMetadata — URL shape rejection', () => {
  it('rejects garbage URLs with INVALID_URL', async () => {
    const result = await safeFetchMetadata('not a url', {
      resolver: fakeResolver({}),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('INVALID_URL')
  })

  it('rejects http:// with NON_HTTPS', async () => {
    const result = await safeFetchMetadata('http://example.com/', {
      resolver: fakeResolver({}),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NON_HTTPS')
  })

  it('rejects file:// with NON_HTTPS', async () => {
    const result = await safeFetchMetadata('file:///etc/passwd', {
      resolver: fakeResolver({}),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NON_HTTPS')
  })

  it('rejects ftp:// with NON_HTTPS', async () => {
    const result = await safeFetchMetadata('ftp://example.com/', {
      resolver: fakeResolver({}),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NON_HTTPS')
  })

  it('rejects javascript: with NON_HTTPS', async () => {
    const result = await safeFetchMetadata('javascript:alert(1)', {
      resolver: fakeResolver({}),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NON_HTTPS')
  })

  it('rejects URLs with embedded basic-auth credentials', async () => {
    const result = await safeFetchMetadata('https://user:pass@example.com/', {
      resolver: fakeResolver({}),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('INVALID_URL')
  })
})

// ─── DNS / private-IP rejection (Layer 3..4) ───────────────────────────

describe('safeFetchMetadata — DNS + private-IP rejection', () => {
  it('rejects with DNS_FAILED when resolver throws', async () => {
    const result = await safeFetchMetadata('https://does-not-exist.test/', {
      resolver: fakeResolver({}),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('DNS_FAILED')
  })

  it('rejects with DNS_FAILED when resolver returns empty', async () => {
    const result = await safeFetchMetadata('https://no-addresses.test/', {
      resolver: fakeResolver({ 'no-addresses.test': [] }),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('DNS_FAILED')
  })

  it('rejects loopback IPv4 with PRIVATE_IP', async () => {
    const result = await safeFetchMetadata('https://localhost.test/', {
      resolver: fakeResolver({
        'localhost.test': [{ address: '127.0.0.1', family: 4 }],
      }),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
  })

  it('rejects RFC 1918 10/8 with PRIVATE_IP', async () => {
    const result = await safeFetchMetadata('https://internal.test/', {
      resolver: fakeResolver({
        'internal.test': [{ address: '10.0.0.5', family: 4 }],
      }),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
  })

  it('rejects AWS metadata IP 169.254.169.254 with PRIVATE_IP', async () => {
    const result = await safeFetchMetadata('https://aws-meta.test/', {
      resolver: fakeResolver({
        'aws-meta.test': [{ address: '169.254.169.254', family: 4 }],
      }),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
  })

  it('rejects IPv6 loopback ::1 with PRIVATE_IP', async () => {
    const result = await safeFetchMetadata('https://v6loopback.test/', {
      resolver: fakeResolver({
        'v6loopback.test': [{ address: '::1', family: 6 }],
      }),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
  })

  it('rejects IPv6 ULA fc00::/7 with PRIVATE_IP', async () => {
    const result = await safeFetchMetadata('https://v6ula.test/', {
      resolver: fakeResolver({
        'v6ula.test': [{ address: 'fc00::1', family: 6 }],
      }),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
  })

  it('rejects when ANY resolved IP is private (mixed result)', async () => {
    const result = await safeFetchMetadata('https://dual-homed.test/', {
      resolver: fakeResolver({
        'dual-homed.test': [
          { address: '52.84.0.1', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      }),
      fetchImpl: sequencedFetch(),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
  })
})

// ─── Happy path ────────────────────────────────────────────────────────

describe('safeFetchMetadata — happy path', () => {
  it('returns bytes + content-type when DNS + IP + 200 OK all align', async () => {
    const xml = '<EntityDescriptor entityID="x"/>'
    const result = await safeFetchMetadata('https://idp.example.com/saml/metadata', {
      resolver: fakeResolver({
        'idp.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      fetchImpl: sequencedFetch({
        status: 200,
        headers: { 'content-type': 'application/samlmetadata+xml' },
        body: xml,
      }),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.bytes.toString('utf-8')).toBe(xml)
      expect(result.contentType).toBe('application/samlmetadata+xml')
      expect(result.finalUrl).toBe('https://idp.example.com/saml/metadata')
    }
  })

  it('accepts public IPv6 addresses', async () => {
    const result = await safeFetchMetadata('https://idp.v6.example.com/m', {
      resolver: fakeResolver({
        'idp.v6.example.com': [
          { address: '2606:4700:4700::1111', family: 6 },
        ],
      }),
      fetchImpl: sequencedFetch({
        status: 200,
        headers: { 'content-type': 'text/xml' },
        body: '<x/>',
      }),
    })
    expect(result.ok).toBe(true)
  })
})

// ─── Redirects (re-validation per hop) ─────────────────────────────────

describe('safeFetchMetadata — redirect handling', () => {
  it('follows a single 302 redirect when both hops resolve to public IPs', async () => {
    const result = await safeFetchMetadata('https://hop1.example.com/m', {
      resolver: fakeResolver({
        'hop1.example.com': [{ address: '52.84.0.1', family: 4 }],
        'hop2.example.com': [{ address: '52.84.0.2', family: 4 }],
      }),
      fetchImpl: sequencedFetch(
        { status: 302, headers: { location: 'https://hop2.example.com/m2' } },
        { status: 200, headers: { 'content-type': 'text/xml' }, body: '<ok/>' },
      ),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalUrl).toBe('https://hop2.example.com/m2')
    }
  })

  it('rejects when redirect target resolves to a private IP', async () => {
    const result = await safeFetchMetadata('https://hop1.example.com/m', {
      resolver: fakeResolver({
        'hop1.example.com': [{ address: '52.84.0.1', family: 4 }],
        'hop2.example.com': [{ address: '10.0.0.1', family: 4 }],
      }),
      fetchImpl: sequencedFetch(
        { status: 302, headers: { location: 'https://hop2.example.com/m2' } },
      ),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
  })

  it('rejects when redirect target switches to http://', async () => {
    const result = await safeFetchMetadata('https://hop1.example.com/m', {
      resolver: fakeResolver({
        'hop1.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      fetchImpl: sequencedFetch(
        { status: 302, headers: { location: 'http://hop1.example.com/m2' } },
      ),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('NON_HTTPS')
  })

  it('rejects redirect with no Location header', async () => {
    const result = await safeFetchMetadata('https://hop1.example.com/m', {
      resolver: fakeResolver({
        'hop1.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      fetchImpl: sequencedFetch({ status: 302, headers: {} }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('BAD_STATUS')
  })

  it('rejects after exceeding maxRedirects', async () => {
    const result = await safeFetchMetadata('https://h.example.com/0', {
      resolver: fakeResolver({
        'h.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      maxRedirects: 2,
      fetchImpl: sequencedFetch(
        { status: 302, headers: { location: 'https://h.example.com/1' } },
        { status: 302, headers: { location: 'https://h.example.com/2' } },
        { status: 302, headers: { location: 'https://h.example.com/3' } },
      ),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('TOO_MANY_REDIRECTS')
  })

  it('resolves relative redirect Locations against the previous URL', async () => {
    const result = await safeFetchMetadata('https://h.example.com/a/b', {
      resolver: fakeResolver({
        'h.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      fetchImpl: sequencedFetch(
        { status: 302, headers: { location: '/c/d' } },
        { status: 200, headers: { 'content-type': 'text/xml' }, body: '<x/>' },
      ),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.finalUrl).toBe('https://h.example.com/c/d')
    }
  })
})

// ─── Response size + status ────────────────────────────────────────────

describe('safeFetchMetadata — response handling', () => {
  it('returns BAD_STATUS for non-2xx', async () => {
    const result = await safeFetchMetadata('https://h.example.com/m', {
      resolver: fakeResolver({
        'h.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      fetchImpl: sequencedFetch({ status: 404, body: 'not found' }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('BAD_STATUS')
      expect(result.error).toContain('404')
    }
  })

  it('rejects oversized responses with TOO_LARGE', async () => {
    const huge = new Uint8Array(2000)
    const result = await safeFetchMetadata('https://h.example.com/m', {
      resolver: fakeResolver({
        'h.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      maxBytes: 1000,
      fetchImpl: sequencedFetch({
        status: 200,
        headers: { 'content-type': 'text/xml' },
        body: huge,
      }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('TOO_LARGE')
  })

  it('returns TIMEOUT when AbortController fires', async () => {
    // We simulate a hung connection by returning a fetch that throws an
    // AbortError when the signal aborts. Setting timeoutMs very low
    // ensures the abort fires before the body resolves.
    const hangingFetch: typeof fetch = (async (_url: string, init: RequestInit) => {
      return await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string }
          err.name = 'AbortError'
          reject(err)
        })
      })
    }) as unknown as typeof fetch
    const result = await safeFetchMetadata('https://h.example.com/m', {
      resolver: fakeResolver({
        'h.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      timeoutMs: 25,
      fetchImpl: hangingFetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('TIMEOUT')
  })

  it('returns BAD_STATUS when fetch throws a non-abort error', async () => {
    const broken: typeof fetch = (async () => {
      throw new Error('connection reset')
    }) as unknown as typeof fetch
    const result = await safeFetchMetadata('https://h.example.com/m', {
      resolver: fakeResolver({
        'h.example.com': [{ address: '52.84.0.1', family: 4 }],
      }),
      fetchImpl: broken,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('BAD_STATUS')
  })
})

// ─── DNS-rebinding ordering check ──────────────────────────────────────

describe('safeFetchMetadata — DNS resolution happens BEFORE fetch', () => {
  it('does not invoke fetch if DNS yields a private IP', async () => {
    const fetchSpy = vi.fn() as unknown as typeof fetch
    const result = await safeFetchMetadata('https://internal.test/', {
      resolver: fakeResolver({
        'internal.test': [{ address: '127.0.0.1', family: 4 }],
      }),
      fetchImpl: fetchSpy,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorCode).toBe('PRIVATE_IP')
    expect((fetchSpy as unknown as ReturnType<typeof vi.fn>).mock?.calls?.length ?? 0).toBe(0)
  })
})
