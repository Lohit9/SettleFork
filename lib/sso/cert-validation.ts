// X.509 signing-certificate validation for SAML metadata. Pure function
// over the base64-encoded DER bytes that appear inside <X509Certificate>
// elements of an IdP metadata document. Returns parsed metadata on
// success, a typed error code on failure.
//
// Validation surface:
//   - Base64 decoding (strict — reject anything that isn't [A-Za-z0-9+/=]).
//   - X.509 parsing via Node's built-in `crypto.X509Certificate`.
//   - Validity window (notBefore <= now <= notAfter).
//   - Key strength: RSA >= 2048 bits, EC P-256 / P-384 / P-521,
//     Ed25519, Ed448. Anything weaker is rejected.
//   - Signature algorithm: rejects SHA-1 RSA, MD5 RSA, MD2 RSA, ECDSA
//     SHA-1. Extracted via a small ASN.1 walk over the DER (the
//     algorithm-identifier OID is the second field of the outer
//     SEQUENCE — we don't need a full ASN.1 parser).
//
// Why hand-rolled ASN.1 instead of a dependency: the only field we
// need is the signature-algorithm OID. The walk is ~30 lines and
// removes any need for `node-forge` or `pkijs`. If the walk ever proves
// brittle on a real-world cert, fall back to Node's deprecated
// `cert.toLegacyObject().sigalg` (still functional in Node 24) before
// considering a new dependency.

import { X509Certificate } from 'node:crypto'

export type CertValidationResult =
  | {
      ok: false
      errorCode:
        | 'CERT_DECODE_FAILED'
        | 'CERT_PARSE_FAILED'
        | 'CERT_EXPIRED'
        | 'CERT_NOT_YET_VALID'
        | 'CERT_WEAK_SIGNATURE_ALG'
        | 'CERT_WEAK_KEY'
      error: string
    }
  | {
      ok: true
      /** Lowercase hex SHA-256, no colons. Used for cert-rotation comparison. */
      fingerprint_sha256: string
      /** RFC-2253 Subject DN string. */
      subject: string
      /** RFC-2253 Issuer DN string. */
      issuer: string
      /** ISO-8601 timestamp; cert is invalid before this. */
      not_before: string
      /** ISO-8601 timestamp; cert is invalid after this. */
      not_after: string
      /** Human-readable name (e.g. "sha256WithRSAEncryption"). */
      signature_algorithm: string
      /** Categorical key type — drives display + further validation. */
      key_type: 'rsa' | 'ec' | 'ed25519' | 'ed448'
      /** Modulus length in bits, RSA only. */
      key_size_bits?: number
      /** Named curve, EC only. */
      key_curve?: string
    }

// Deprecated signature-algorithm OIDs that we explicitly reject. Sources:
//   sha1WithRSAEncryption  1.2.840.113549.1.1.5  (NIST disallowed since 2013)
//   md5WithRSAEncryption   1.2.840.113549.1.1.4  (collision attacks since 2008)
//   md2WithRSAEncryption   1.2.840.113549.1.1.2
//   ecdsa-with-SHA1        1.2.840.10045.4.1
const DEPRECATED_SIG_OIDS = new Set([
  '1.2.840.113549.1.1.5',
  '1.2.840.113549.1.1.4',
  '1.2.840.113549.1.1.2',
  '1.2.840.10045.4.1',
])

const SIG_OID_NAMES: Record<string, string> = {
  '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
  '1.2.840.113549.1.1.4': 'md5WithRSAEncryption',
  '1.2.840.113549.1.1.2': 'md2WithRSAEncryption',
  '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
  '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
  '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
  '1.2.840.113549.1.1.10': 'rsassa-pss',
  '1.2.840.10045.4.1': 'ecdsa-with-SHA1',
  '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256',
  '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
  '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
  '1.3.101.112': 'Ed25519',
  '1.3.101.113': 'Ed448',
}

const ACCEPTABLE_EC_CURVES = new Set(['prime256v1', 'secp384r1', 'secp521r1'])

/**
 * Validate a base64-encoded DER X.509 certificate (as found in SAML
 * metadata inside `<X509Certificate>` elements).
 *
 * @param base64Cert - Base64-encoded DER bytes. Whitespace inside the
 *   string is tolerated and stripped (XML pretty-printing often adds
 *   newlines and spaces); PEM markers are NOT accepted — strip them
 *   before calling if necessary.
 */
export function validateSigningCert(base64Cert: string): CertValidationResult {
  // ── Step 1: strict base64 decode ─────────────────────────────────
  let der: Buffer
  try {
    const stripped = base64Cert.replace(/\s+/g, '')
    if (stripped.length === 0) {
      return {
        ok: false,
        errorCode: 'CERT_DECODE_FAILED',
        error: 'Empty certificate',
      }
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
      return {
        ok: false,
        errorCode: 'CERT_DECODE_FAILED',
        error: 'Certificate is not valid base64',
      }
    }
    der = Buffer.from(stripped, 'base64')
    if (der.length === 0) {
      return {
        ok: false,
        errorCode: 'CERT_DECODE_FAILED',
        error: 'Empty certificate after base64 decode',
      }
    }
  } catch {
    return {
      ok: false,
      errorCode: 'CERT_DECODE_FAILED',
      error: 'Base64 decode failed',
    }
  }

  // ── Step 2: parse as X.509 via Node built-in ─────────────────────
  let cert: X509Certificate
  try {
    cert = new X509Certificate(der)
  } catch (err) {
    return {
      ok: false,
      errorCode: 'CERT_PARSE_FAILED',
      error: `X.509 parse failed: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }

  // ── Step 3: validity window ──────────────────────────────────────
  const notBefore = new Date(cert.validFrom)
  const notAfter = new Date(cert.validTo)
  if (Number.isNaN(notBefore.getTime()) || Number.isNaN(notAfter.getTime())) {
    return {
      ok: false,
      errorCode: 'CERT_PARSE_FAILED',
      error: 'Certificate has invalid validity dates',
    }
  }
  const now = new Date()
  if (now < notBefore) {
    return {
      ok: false,
      errorCode: 'CERT_NOT_YET_VALID',
      error: `Certificate not valid until ${notBefore.toISOString()}`,
    }
  }
  if (now > notAfter) {
    return {
      ok: false,
      errorCode: 'CERT_EXPIRED',
      error: `Certificate expired on ${notAfter.toISOString()}`,
    }
  }

  // ── Step 4: key strength ─────────────────────────────────────────
  const pk = cert.publicKey
  let keyType: 'rsa' | 'ec' | 'ed25519' | 'ed448'
  let keySizeBits: number | undefined
  let keyCurve: string | undefined

  switch (pk.asymmetricKeyType) {
    case 'rsa':
    case 'rsa-pss': {
      keyType = 'rsa'
      const details = pk.asymmetricKeyDetails as
        | { modulusLength?: number }
        | undefined
      keySizeBits = details?.modulusLength
      if (!keySizeBits || keySizeBits < 2048) {
        return {
          ok: false,
          errorCode: 'CERT_WEAK_KEY',
          error: `RSA key must be at least 2048 bits (got ${keySizeBits ?? 'unknown'})`,
        }
      }
      break
    }
    case 'ec': {
      keyType = 'ec'
      const details = pk.asymmetricKeyDetails as
        | { namedCurve?: string }
        | undefined
      keyCurve = details?.namedCurve
      if (!keyCurve || !ACCEPTABLE_EC_CURVES.has(keyCurve)) {
        return {
          ok: false,
          errorCode: 'CERT_WEAK_KEY',
          error: `EC curve must be P-256, P-384, or P-521 (got ${keyCurve ?? 'unknown'})`,
        }
      }
      break
    }
    case 'ed25519':
      keyType = 'ed25519'
      break
    case 'ed448':
      keyType = 'ed448'
      break
    default:
      return {
        ok: false,
        errorCode: 'CERT_WEAK_KEY',
        error: `Unsupported key type: ${pk.asymmetricKeyType ?? 'unknown'}`,
      }
  }

  // ── Step 5: signature algorithm OID ──────────────────────────────
  const sigAlgOid = extractSignatureAlgorithmOid(der)
  if (sigAlgOid && DEPRECATED_SIG_OIDS.has(sigAlgOid)) {
    const human = SIG_OID_NAMES[sigAlgOid] ?? sigAlgOid
    return {
      ok: false,
      errorCode: 'CERT_WEAK_SIGNATURE_ALG',
      error: `Signature algorithm ${human} is deprecated and not accepted`,
    }
  }
  const signatureAlgorithm = sigAlgOid
    ? (SIG_OID_NAMES[sigAlgOid] ?? sigAlgOid)
    : 'unknown'

  // ── Step 6: fingerprint (sha256, lowercase hex, no colons) ───────
  const fingerprint = cert.fingerprint256.toLowerCase().replace(/:/g, '')

  return {
    ok: true,
    fingerprint_sha256: fingerprint,
    subject: cert.subject,
    issuer: cert.issuer,
    not_before: notBefore.toISOString(),
    not_after: notAfter.toISOString(),
    signature_algorithm: signatureAlgorithm,
    key_type: keyType,
    key_size_bits: keySizeBits,
    key_curve: keyCurve,
  }
}

// ─── ASN.1 walk: extract signatureAlgorithm OID ────────────────────────
//
// X.509 (RFC 5280):
//   Certificate ::= SEQUENCE {
//     tbsCertificate       TBSCertificate,
//     signatureAlgorithm   AlgorithmIdentifier,    <-- this
//     signatureValue       BIT STRING
//   }
//   AlgorithmIdentifier ::= SEQUENCE {
//     algorithm   OBJECT IDENTIFIER,                <-- the OID we want
//     parameters  ANY DEFINED BY algorithm OPTIONAL
//   }
//
// The walk: open the outer SEQUENCE, skip past the tbsCertificate
// SEQUENCE (whose length tells us where it ends), open the
// signatureAlgorithm SEQUENCE, take the first element which must be
// OBJECT IDENTIFIER, decode the OID. Returns null if any byte
// disagrees with the expected structure.

/**
 * Extract the signatureAlgorithm OID from a DER-encoded X.509 certificate.
 *
 * @returns the OID as a dotted string (e.g. "1.2.840.113549.1.1.11"), or
 *   `null` if extraction fails. A `null` is treated by the caller as
 *   "unknown" — the cert's signatureAlgorithm field will simply not be
 *   recorded, but validation continues so a parse-only quirk doesn't
 *   block all cert-validation calls.
 */
function extractSignatureAlgorithmOid(der: Buffer): string | null {
  try {
    let pos = 0

    // Outer SEQUENCE
    if (der[pos] !== 0x30) return null
    pos++
    pos += skipLengthBytes(der, pos)

    // tbsCertificate (first SEQUENCE)
    if (der[pos] !== 0x30) return null
    const tbsLengthBytes = skipLengthBytes(der, pos + 1)
    const tbsLength = readLength(der, pos + 1)
    pos += 1 + tbsLengthBytes + tbsLength

    // signatureAlgorithm (second SEQUENCE)
    if (der[pos] !== 0x30) return null
    pos++
    pos += skipLengthBytes(der, pos)

    // First element must be OBJECT IDENTIFIER (tag 0x06)
    if (der[pos] !== 0x06) return null
    pos++
    const oidLength = readLength(der, pos)
    pos += skipLengthBytes(der, pos)

    if (pos + oidLength > der.length) return null
    return decodeOid(der.subarray(pos, pos + oidLength))
  } catch {
    return null
  }
}

/**
 * Read an ASN.1 BER/DER length value from `der` starting at `pos`.
 * Returns the length, NOT the number of bytes the length itself
 * occupies (use `skipLengthBytes` for that).
 */
function readLength(der: Buffer, pos: number): number {
  if (pos >= der.length) throw new Error('ASN.1: out of bounds')
  const first = der[pos]!
  if (first < 0x80) return first
  const numBytes = first & 0x7f
  if (numBytes === 0 || numBytes > 4) {
    throw new Error('ASN.1: unsupported length encoding')
  }
  if (pos + 1 + numBytes > der.length) {
    throw new Error('ASN.1: out of bounds')
  }
  let len = 0
  for (let i = 0; i < numBytes; i++) {
    len = (len << 8) | der[pos + 1 + i]!
  }
  return len
}

/**
 * Number of bytes consumed by an ASN.1 length encoding starting at `pos`.
 * For short form (length < 128) this is 1; for long form it is
 * 1 + (number-of-length-bytes).
 */
function skipLengthBytes(der: Buffer, pos: number): number {
  if (pos >= der.length) throw new Error('ASN.1: out of bounds')
  const first = der[pos]!
  if (first < 0x80) return 1
  return 1 + (first & 0x7f)
}

/**
 * Decode an OID from its DER-encoded byte sequence.
 *
 * The first byte encodes the first two arcs as `40 * arc0 + arc1`
 * (with arc0 in {0,1,2}). All subsequent arcs are base-128 with the
 * high bit indicating "more bytes follow".
 */
function decodeOid(bytes: Buffer): string {
  if (bytes.length === 0) return ''

  const arc0 = Math.floor(bytes[0]! / 40)
  const arc1 = bytes[0]! % 40
  const arcs: number[] = [arc0, arc1]

  let value = 0
  for (let i = 1; i < bytes.length; i++) {
    value = (value << 7) | (bytes[i]! & 0x7f)
    if ((bytes[i]! & 0x80) === 0) {
      arcs.push(value)
      value = 0
    }
  }

  return arcs.join('.')
}
