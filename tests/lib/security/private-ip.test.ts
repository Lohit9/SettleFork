// @vitest-environment node
//
// Coverage for `lib/security/private-ip.ts`. The matcher backs the SSRF
// defenses in `safe-fetch.ts`, so a regression here would weaken every
// outbound metadata fetch the platform makes. Tests are organized by
// CIDR range, parametrized over multiple in-range and out-of-range
// examples per range so a single off-by-one bug surfaces fast.

import { describe, it, expect } from 'vitest'

import { isPrivateOrSpecialIP } from '@/lib/security/private-ip'

describe('isPrivateOrSpecialIP — invalid input', () => {
  it.each([
    ['', 'empty string'],
    ['not-an-ip', 'word'],
    ['1.2.3', 'too few octets'],
    ['1.2.3.4.5', 'too many octets'],
    ['1.2.3.999', 'octet > 255'],
    ['1.2.3.-1', 'negative octet'],
    ['::g', 'illegal hex'],
    ['1::1::1', 'two ::'],
    ['12345::', 'group > 4 hex chars'],
  ])('rejects %s as suspicious (%s)', (input) => {
    expect(isPrivateOrSpecialIP(input)).toBe(true)
  })
})

describe('isPrivateOrSpecialIP — IPv4 private/special ranges', () => {
  it.each([
    // 0.0.0.0/8 ("this network")
    ['0.0.0.0', '0/8'],
    ['0.255.255.255', '0/8 high'],
    // 10.0.0.0/8
    ['10.0.0.0', '10/8 low'],
    ['10.255.255.255', '10/8 high'],
    // 100.64.0.0/10 (CGNAT)
    ['100.64.0.0', 'CGNAT low'],
    ['100.127.255.255', 'CGNAT high'],
    // 127.0.0.0/8 (loopback)
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback high'],
    // 169.254.0.0/16 (link-local)
    ['169.254.0.0', 'link-local low'],
    ['169.254.169.254', 'AWS metadata'],
    // 172.16.0.0/12
    ['172.16.0.0', '172.16 low'],
    ['172.31.255.255', '172.31 high'],
    // 192.0.0.0/24
    ['192.0.0.0', 'IETF protocol assignments low'],
    ['192.0.0.255', 'IETF protocol assignments high'],
    // 192.0.2.0/24 (TEST-NET-1)
    ['192.0.2.1', 'TEST-NET-1'],
    // 192.88.99.0/24 (deprecated 6to4)
    ['192.88.99.1', '6to4 anycast'],
    // 192.168.0.0/16
    ['192.168.0.0', '192.168 low'],
    ['192.168.255.255', '192.168 high'],
    // 198.18.0.0/15 (benchmarking)
    ['198.18.0.0', 'benchmarking low'],
    ['198.19.255.255', 'benchmarking high'],
    // 198.51.100.0/24 (TEST-NET-2)
    ['198.51.100.42', 'TEST-NET-2'],
    // 203.0.113.0/24 (TEST-NET-3)
    ['203.0.113.42', 'TEST-NET-3'],
    // 224.0.0.0/4 (multicast)
    ['224.0.0.1', 'multicast low'],
    ['239.255.255.255', 'multicast high'],
    // 240.0.0.0/4 (reserved + broadcast)
    ['240.0.0.1', 'reserved low'],
    ['255.255.255.255', 'broadcast'],
  ])('rejects %s (%s)', (ip) => {
    expect(isPrivateOrSpecialIP(ip)).toBe(true)
  })
})

describe('isPrivateOrSpecialIP — IPv4 public ranges', () => {
  it.each([
    ['1.1.1.1', 'Cloudflare DNS'],
    ['8.8.8.8', 'Google DNS'],
    ['9.9.9.9', 'Quad9 DNS'],
    ['11.0.0.1', 'just outside 10/8'],
    ['100.63.255.255', 'just below CGNAT'],
    ['100.128.0.0', 'just above CGNAT'],
    ['126.0.0.1', 'just below loopback'],
    ['128.0.0.1', 'just above loopback'],
    ['169.253.0.0', 'just below link-local'],
    ['169.255.0.0', 'just above link-local'],
    ['172.15.255.255', 'just below 172.16/12'],
    ['172.32.0.0', 'just above 172.16/12'],
    ['172.20.0.1', 'note: 172.20 is INSIDE 172.16/12 (private)'], // sanity
    ['192.167.255.255', 'just below 192.168/16'],
    ['192.169.0.0', 'just above 192.168/16'],
    ['198.17.255.255', 'just below benchmarking'],
    ['198.20.0.0', 'just above benchmarking'],
    ['198.51.99.255', 'just below TEST-NET-2'],
    ['198.51.101.0', 'just above TEST-NET-2'],
    ['203.0.112.255', 'just below TEST-NET-3'],
    ['203.0.114.0', 'just above TEST-NET-3'],
    ['223.255.255.255', 'just below multicast'],
    ['52.84.0.1', 'arbitrary public'],
  ])('accepts %s (%s)', (ip, label) => {
    // Sanity: 172.20.0.1 is intentionally INSIDE the private range.
    if (label?.startsWith('note: 172.20')) {
      expect(isPrivateOrSpecialIP(ip)).toBe(true)
      return
    }
    expect(isPrivateOrSpecialIP(ip)).toBe(false)
  })
})

describe('isPrivateOrSpecialIP — IPv6 special ranges', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    // fe80::/10 link-local
    ['fe80::1', 'link-local low'],
    ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'link-local high'],
    // fc00::/7 ULA
    ['fc00::', 'ULA low'],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ULA high'],
    // ff00::/8 multicast
    ['ff00::', 'multicast low'],
    ['ff02::1', 'all-nodes multicast'],
    ['ffff::1', 'multicast high'],
    // 64:ff9b::/96 NAT64
    ['64:ff9b::1', 'NAT64'],
    // 100::/64 discard
    ['100::1', 'discard prefix'],
    // 2001:db8::/32 documentation
    ['2001:db8::1', 'documentation'],
    ['2001:db8:abcd:ef::1', 'documentation full'],
    // 2001:2::/48 benchmarking
    ['2001:2:0:1::', 'benchmarking'],
    // IPv4-mapped private
    ['::ffff:10.0.0.1', 'mapped 10/8'],
    ['::ffff:127.0.0.1', 'mapped loopback'],
    ['::ffff:169.254.169.254', 'mapped AWS metadata'],
    ['::ffff:192.168.1.1', 'mapped 192.168'],
    // IPv4-compatible (deprecated)
    ['::10.0.0.1', 'compat 10/8'],
  ])('rejects %s (%s)', (ip) => {
    expect(isPrivateOrSpecialIP(ip)).toBe(true)
  })
})

describe('isPrivateOrSpecialIP — IPv6 public ranges', () => {
  it.each([
    ['2001:4860:4860::8888', 'Google DNS v6'],
    ['2606:4700:4700::1111', 'Cloudflare DNS v6'],
    ['2001:db7::1', 'just below documentation'], // 2001:0db7
    ['2001:db9::1', 'just above documentation'],
    ['fdff::1', 'note: still ULA'], // sanity — fdff is ULA
    ['fe7f::1', 'just below link-local'],
    ['fec0::1', 'just above link-local (deprecated site-local)'],
    ['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'just below ULA'],
    ['::ffff:8.8.8.8', 'mapped public IPv4'],
    ['64:ff9c::1', 'just past NAT64'],
    ['65:ff9b::1', 'just past NAT64 by 16-bit group'],
  ])('classifies %s correctly (%s)', (ip, label) => {
    if (label === 'note: still ULA') {
      expect(isPrivateOrSpecialIP(ip)).toBe(true)
      return
    }
    expect(isPrivateOrSpecialIP(ip)).toBe(false)
  })
})

describe('isPrivateOrSpecialIP — IPv6 link-local boundary', () => {
  it.each([
    // Inside fe80::/10
    'fe80::1',
    'fe81::1',
    'fea0::1',
    'feb0::1',
    'febf::1',
  ])('treats %s as link-local', (ip) => {
    expect(isPrivateOrSpecialIP(ip)).toBe(true)
  })

  it.each([
    // OUTSIDE fe80::/10 — these used to false-positive under the
    // earlier regex-based implementation.
    'feb::1',     // expands to 0feb:: which is NOT link-local
    'fec0::1',    // first 10 bits 1111111011 — site-local, deprecated
    'fec1::1',    // 0xfec1 — first 10 bits don't match link-local prefix
  ])('does NOT treat %s as link-local', (ip) => {
    expect(isPrivateOrSpecialIP(ip)).toBe(false)
  })
})
