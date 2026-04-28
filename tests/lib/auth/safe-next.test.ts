// @vitest-environment node
//
// Unit tests for `lib/auth/safe-next.ts` — the canonical safe-redirect
// resolver shared by the login form and `/sso/start`. Pins:
//
//   - Default fallback is '/app/projects' on null/empty/missing.
//   - Both `redirect` and `returnTo` params are honored, with `redirect`
//     winning when both are present (back-compat with existing emitters).
//   - Open-redirect protection: rejects `//evil.com`, `https://evil.com`,
//     `javascript:`, anything not starting with `/`.
//   - CRLF header-injection protection: rejects strings containing `\r`
//     or `\n`.
//
// Written against a minimal `{ get(key): string | null }` shim to keep
// the helper's contract framework-agnostic — both `URLSearchParams` and
// Next's `ReadonlyURLSearchParams` satisfy this shape.

import { describe, it, expect } from 'vitest'
import { getSafeNext, isSafePath } from '@/lib/auth/safe-next'

function mkParams(map: Record<string, string>): {
  get(key: string): string | null
} {
  return {
    get(key: string) {
      return key in map ? map[key] : null
    },
  }
}

describe('getSafeNext — fallback', () => {
  it('returns /app/projects when no params present', () => {
    expect(getSafeNext(mkParams({}))).toBe('/app/projects')
  })

  it('returns /app/projects when redirect is empty string', () => {
    expect(getSafeNext(mkParams({ redirect: '' }))).toBe('/app/projects')
  })

  it('returns /app/projects when returnTo is empty string', () => {
    expect(getSafeNext(mkParams({ returnTo: '' }))).toBe('/app/projects')
  })

  it('accepts a real URLSearchParams instance (not just the shim)', () => {
    const sp = new URLSearchParams('redirect=/app/projects/abc')
    expect(getSafeNext(sp)).toBe('/app/projects/abc')
  })
})

describe('getSafeNext — happy path', () => {
  it('returns the path when redirect is a same-origin absolute path', () => {
    expect(
      getSafeNext(mkParams({ redirect: '/app/projects/123' })),
    ).toBe('/app/projects/123')
  })

  it('returns the path when returnTo is a same-origin absolute path', () => {
    expect(
      getSafeNext(mkParams({ returnTo: '/app/projects/123' })),
    ).toBe('/app/projects/123')
  })

  it('prefers redirect over returnTo when both are present', () => {
    expect(
      getSafeNext(
        mkParams({ redirect: '/app/redirect-wins', returnTo: '/app/lost' }),
      ),
    ).toBe('/app/redirect-wins')
  })

  it('preserves query strings inside the candidate', () => {
    expect(
      getSafeNext(mkParams({ redirect: '/app/projects?tab=schemas' })),
    ).toBe('/app/projects?tab=schemas')
  })

  it('preserves URL-encoded characters in the candidate', () => {
    expect(
      getSafeNext(
        mkParams({ redirect: '/invite/abc%20def' }),
      ),
    ).toBe('/invite/abc%20def')
  })
})

describe('getSafeNext — open-redirect rejection', () => {
  it('rejects protocol-relative // URLs (//evil.com)', () => {
    expect(
      getSafeNext(mkParams({ redirect: '//evil.com/steal' })),
    ).toBe('/app/projects')
  })

  it('rejects protocol-relative // URLs even with leading whitespace handling not happening', () => {
    // The helper does NOT trim. A leading-space candidate fails the
    // startsWith('/') check and falls back. This is intentional —
    // emitters should produce well-formed URLs.
    expect(
      getSafeNext(mkParams({ redirect: ' /app/projects' })),
    ).toBe('/app/projects')
  })

  it('rejects absolute https URLs', () => {
    expect(
      getSafeNext(mkParams({ redirect: 'https://evil.com/path' })),
    ).toBe('/app/projects')
  })

  it('rejects absolute http URLs', () => {
    expect(
      getSafeNext(mkParams({ redirect: 'http://evil.com/path' })),
    ).toBe('/app/projects')
  })

  it('rejects javascript: pseudo-URLs', () => {
    expect(
      getSafeNext(mkParams({ redirect: 'javascript:alert(1)' })),
    ).toBe('/app/projects')
  })

  it('rejects data: pseudo-URLs', () => {
    expect(
      getSafeNext(mkParams({ redirect: 'data:text/html,<script>1</script>' })),
    ).toBe('/app/projects')
  })

  it('rejects bare path segments without leading slash', () => {
    expect(
      getSafeNext(mkParams({ redirect: 'app/projects' })),
    ).toBe('/app/projects')
  })
})

describe('getSafeNext — CRLF rejection', () => {
  it('rejects \\r in the candidate', () => {
    expect(
      getSafeNext(mkParams({ redirect: '/app/projects\rSet-Cookie: evil' })),
    ).toBe('/app/projects')
  })

  it('rejects \\n in the candidate', () => {
    expect(
      getSafeNext(mkParams({ redirect: '/app/projects\nSet-Cookie: evil' })),
    ).toBe('/app/projects')
  })

  it('rejects \\r\\n combined', () => {
    expect(
      getSafeNext(
        mkParams({ redirect: '/app/projects\r\nSet-Cookie: evil' }),
      ),
    ).toBe('/app/projects')
  })

  it('rejects CRLF in returnTo as well', () => {
    expect(
      getSafeNext(mkParams({ returnTo: '/app\nstuff' })),
    ).toBe('/app/projects')
  })
})

describe('getSafeNext — fallback when redirect is invalid but returnTo is valid', () => {
  // Documented behavior: the helper picks `redirect ?? returnTo` and
  // validates ONCE. It does not "try redirect, fall back to returnTo on
  // rejection." Reasoning: if an attacker supplies a bad `redirect`,
  // silently honoring a different `returnTo` could mask the attack and
  // surprise the user. Better to fail-soft to /app/projects.
  it('does NOT fall back to returnTo when redirect is malformed', () => {
    expect(
      getSafeNext(
        mkParams({ redirect: '//evil.com', returnTo: '/app/projects/123' }),
      ),
    ).toBe('/app/projects')
  })
})

describe('getSafeNext — custom keys option', () => {
  // /sso/start reads `?next=` rather than `?redirect=`. The keys
  // option lets it reuse the same validator without forking the
  // rule logic.
  it('honors a custom single-key list (e.g. ["next"] for /sso/start)', () => {
    expect(
      getSafeNext(mkParams({ next: '/app/projects/abc' }), { keys: ['next'] }),
    ).toBe('/app/projects/abc')
  })

  it('falls back to default when custom key is absent', () => {
    expect(
      getSafeNext(mkParams({ redirect: '/app/projects/abc' }), {
        keys: ['next'],
      }),
    ).toBe('/app/projects')
  })

  it('rejects // open-redirect when custom key carries it', () => {
    expect(
      getSafeNext(mkParams({ next: '//evil.com' }), { keys: ['next'] }),
    ).toBe('/app/projects')
  })

  it('respects key order — first present wins, malformed earlier key does NOT fall through', () => {
    // Same anti-fall-through invariant as the default keys: if the
    // first key is present but malformed, we go to fallback. Putting
    // the malformed value in `keys[0]` and a valid value in
    // `keys[1]` should yield the fallback, not the keys[1] value.
    expect(
      getSafeNext(mkParams({ a: '//evil.com', b: '/app/projects/x' }), {
        keys: ['a', 'b'],
      }),
    ).toBe('/app/projects')
  })

  it('walks past missing keys to find the first present one', () => {
    // When keys[0] is missing entirely, keys[1] is consulted. (This
    // is distinct from "keys[0] is present-but-bad" above.)
    expect(
      getSafeNext(mkParams({ b: '/app/projects/x' }), {
        keys: ['a', 'b'],
      }),
    ).toBe('/app/projects/x')
  })
})

describe('isSafePath — predicate', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(isSafePath(input)).toBe(false)
  })

  it.each([
    ['/'],
    ['/app/projects'],
    ['/app/projects/abc'],
    ['/app/projects?tab=schemas'],
    ['/invite/some%20token'],
    ['/a/b/c#fragment'],
  ])('accepts safe path %s', (input) => {
    expect(isSafePath(input)).toBe(true)
  })

  it.each([
    ['protocol-relative //', '//evil.com/path'],
    ['absolute https', 'https://evil.com/'],
    ['absolute http', 'http://evil.com/'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,evil'],
    ['no leading slash', 'app/projects'],
    ['leading whitespace', ' /app/projects'],
    ['CRLF', '/app\r\nSet-Cookie: evil'],
    ['bare CR', '/app\rfoo'],
    ['bare LF', '/app\nfoo'],
  ])('rejects %s (%s)', (_label, input) => {
    expect(isSafePath(input)).toBe(false)
  })
})
