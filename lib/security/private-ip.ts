// Private / special-use IP-range matchers. The SSRF defense in
// `lib/security/safe-fetch.ts` relies on these returning `true` for any
// address that must not be reachable from a server-side fetch — RFC 1918
// private space, loopback, link-local, CGNAT, multicast, IANA reserved,
// IPv4-mapped IPv6, IPv6 ULA, etc. Pure functions, no I/O, no DNS.
//
// Why hand-roll: the npm ecosystem options (`ip-address`, `is-cidr`,
// `private-ip`) all carry larger surface than we need and have had their
// own CVEs around IPv4-in-IPv6 normalization. A small, well-commented,
// well-tested matcher is easier to audit than an opaque library.
//
// Threat model: we treat any non-public address as suspicious, including
// invalid input strings. `isPrivateOrSpecialIP('not-an-ip')` returns
// `true` so a malformed lookup result fails closed, never open.
//
// Implementation note: rather than regex-matching IPv6 in compact form
// (which has many false-positive traps because leading zeros are
// dropped and `::` can appear in any group position), we parse the
// address into eight 16-bit groups and compare the high-order groups
// numerically. This is harder to get wrong than regex.

import { isIP } from 'node:net'

/**
 * Determines whether an IP address is in a private, special-use, or
 * otherwise non-public range. SSRF defense relies on this returning
 * `true` for any address that should not be fetchable from a server-side
 * context.
 *
 * Covers IPv4 and IPv6. Returns `true` for ANY of:
 *   - Loopback (127.0.0.0/8, ::1)
 *   - Private RFC 1918 (10/8, 172.16/12, 192.168/16)
 *   - Link-local (169.254/16, fe80::/10)
 *   - Carrier-grade NAT (100.64/10)
 *   - Documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24,
 *     2001:db8::/32)
 *   - Benchmarking (198.18/15, 2001:2::/48)
 *   - Multicast (224/4, ff00::/8)
 *   - Reserved (240/4, 255.255.255.255)
 *   - 0.0.0.0/8 ("this network")
 *   - IPv6 ULA (fc00::/7)
 *   - IPv6 unspecified (::)
 *   - IPv4-mapped IPv6 (::ffff:0:0/96) — un-map to IPv4 and recheck
 *   - IPv4-compatible IPv6 (::a.b.c.d) — un-map to IPv4 and recheck
 *   - Discard-only (100::/64), NAT64 well-known prefix (64:ff9b::/96)
 *   - Anything that isn't a valid IP literal (fail closed)
 *
 * @param ip - IP address string (IPv4 or IPv6)
 * @returns true if the IP should be rejected for outbound HTTP fetches
 */
export function isPrivateOrSpecialIP(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) {
    // Not a recognizable IP literal — fail closed.
    return true
  }
  return family === 4 ? isPrivateIPv4(ip) : isPrivateIPv6(ip)
}

// ─── IPv4 ──────────────────────────────────────────────────────────────

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return true
  }

  const [a, b, c] = parts as [number, number, number, number]

  // 0.0.0.0/8 — "this network"
  if (a === 0) return true
  // 10.0.0.0/8 — RFC 1918
  if (a === 10) return true
  // 100.64.0.0/10 — Carrier-Grade NAT (RFC 6598)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 127.0.0.0/8 — loopback
  if (a === 127) return true
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 — RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.0.0.0/24 — IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 0) return true
  // 192.0.2.0/24 — TEST-NET-1
  if (a === 192 && b === 0 && c === 2) return true
  // 192.88.99.0/24 — 6to4 anycast (deprecated)
  if (a === 192 && b === 88 && c === 99) return true
  // 192.168.0.0/16 — RFC 1918
  if (a === 192 && b === 168) return true
  // 198.18.0.0/15 — benchmarking (RFC 2544)
  if (a === 198 && (b === 18 || b === 19)) return true
  // 198.51.100.0/24 — TEST-NET-2
  if (a === 198 && b === 51 && c === 100) return true
  // 203.0.113.0/24 — TEST-NET-3
  if (a === 203 && b === 0 && c === 113) return true
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true
  // 240.0.0.0/4 — reserved (includes 255.255.255.255 broadcast)
  if (a >= 240) return true

  return false
}

// ─── IPv6 ──────────────────────────────────────────────────────────────

/**
 * Expand a (validated) IPv6 string into eight 16-bit numeric groups.
 * Handles `::` zero-compression and embedded IPv4 (`::ffff:1.2.3.4`).
 *
 * Returns `null` if the input cannot be parsed (treated as suspicious by
 * the caller). The caller is expected to pass a string that already
 * passed `isIP(ip) === 6`, so this function's parser is conservative,
 * not a full validator.
 *
 * Embedded IPv4 in the last 32 bits is folded into two 16-bit groups.
 */
function expandIPv6(ip: string): readonly [number, number, number, number, number, number, number, number] | null {
  const lowered = ip.toLowerCase()

  // Detect and split embedded IPv4 (last colon-segment contains a dot).
  let head = lowered
  let tailGroups: number[] = []
  const lastColon = lowered.lastIndexOf(':')
  if (lastColon !== -1 && lowered.slice(lastColon + 1).includes('.')) {
    const dotted = lowered.slice(lastColon + 1)
    const octets = dotted.split('.').map((p) => Number(p))
    if (
      octets.length !== 4 ||
      octets.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
    ) {
      return null
    }
    tailGroups = [
      (octets[0]! << 8) | octets[1]!,
      (octets[2]! << 8) | octets[3]!,
    ]
    head = lowered.slice(0, lastColon)
  }

  // Split on `::` to handle zero-compression. There is at most one `::`
  // in a valid IPv6 string.
  const halves = head.split('::')
  if (halves.length > 2) return null

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return []
    const parts = s.split(':')
    const out: number[] = []
    for (const part of parts) {
      if (part.length === 0 || part.length > 4 || !/^[0-9a-f]+$/.test(part)) {
        return null
      }
      out.push(parseInt(part, 16))
    }
    return out
  }

  const left = parseGroups(halves[0]!)
  if (left === null) return null
  const right = halves.length === 2 ? parseGroups(halves[1]!) : []
  if (right === null) return null

  const explicitGroupCount = left.length + right.length + tailGroups.length
  if (explicitGroupCount > 8) return null
  if (halves.length === 1 && explicitGroupCount !== 8) return null

  const zeroFill = 8 - explicitGroupCount
  const groups = [...left, ...new Array(zeroFill).fill(0), ...right, ...tailGroups]
  if (groups.length !== 8) return null

  return groups as unknown as readonly [number, number, number, number, number, number, number, number]
}

function isPrivateIPv6(ip: string): boolean {
  const groups = expandIPv6(ip)
  if (!groups) {
    // Could not expand — fail closed.
    return true
  }

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups

  // ::1 — loopback (groups all zero except the last, which is 1).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true
  }

  // :: — unspecified.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) {
    return true
  }

  // IPv4-mapped IPv6 (::ffff:a.b.c.d == ::ffff:wxyz). The first 80 bits
  // are zero, then group[5] === 0xffff, then the last 32 bits encode an
  // IPv4 address. Un-map and re-check against the IPv4 ranges.
  if (
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 &&
    g5 === 0xffff
  ) {
    const a = (g6 >> 8) & 0xff
    const b = g6 & 0xff
    const c = (g7 >> 8) & 0xff
    const d = g7 & 0xff
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`)
  }

  // IPv4-compatible IPv6 (::a.b.c.d) — first 96 bits zero. Deprecated
  // but still parseable; treat the embedded IPv4 the same way.
  if (
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 &&
    !(g6 === 0 && g7 === 0) &&
    !(g6 === 0 && g7 === 1)
  ) {
    const a = (g6 >> 8) & 0xff
    const b = g6 & 0xff
    const c = (g7 >> 8) & 0xff
    const d = g7 & 0xff
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`)
  }

  // fe80::/10 — link-local. First 10 bits = 1111111010, i.e. group[0]
  // in [0xfe80, 0xfebf].
  if (g0 >= 0xfe80 && g0 <= 0xfebf) return true

  // fc00::/7 — Unique Local Addresses (RFC 4193). First 7 bits = 1111110,
  // i.e. group[0] in [0xfc00, 0xfdff].
  if (g0 >= 0xfc00 && g0 <= 0xfdff) return true

  // ff00::/8 — multicast. First 8 bits = 0xff, i.e. group[0] >= 0xff00.
  if (g0 >= 0xff00) return true

  // 64:ff9b::/96 — NAT64 well-known prefix (RFC 6052).
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return true
  }
  // 64:ff9b:1::/48 — local NAT64 (RFC 8215).
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) {
    return true
  }

  // 100::/64 — Discard Prefix (RFC 6666).
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true

  // 2001:db8::/32 — documentation (RFC 3849).
  if (g0 === 0x2001 && g1 === 0xdb8) return true

  // 2001:2::/48 — benchmarking (RFC 5180).
  if (g0 === 0x2001 && g1 === 0x2 && g2 === 0) return true

  return false
}
