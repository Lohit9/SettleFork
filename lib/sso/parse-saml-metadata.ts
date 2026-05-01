// SAML 2.0 IdP metadata parser. Hands a caller the entityID, signing
// cert metadata, SSO/SLO endpoints, and an IdP-type hint extracted from
// raw metadata XML — provided every layer of our defenses passes.
//
// Defense layers (must all pass before we trust any extracted field):
//
//   Layer 1 — pre-parse byte scan. Reject before invoking the parser:
//     - oversized input (> 1 MB)
//     - any DOCTYPE (defeats classic XXE: file:// entity, http:// entity,
//       parameter-entity recursion)
//     - any <!ENTITY> declaration outside DOCTYPE (some parsers accept
//       these; we don't)
//     - any processing instruction other than <?xml (defeats
//       PHP-tag-style smuggling and unknown-PI side effects)
//
//   Layer 2 — fast-xml-parser's XMLValidator structural validator.
//
//   Layer 3 — fast-xml-parser parse with safe options:
//     - processEntities: false   (no entity expansion, ever)
//     - removeNSPrefix: true     (md:EntityDescriptor → EntityDescriptor;
//                                 multi-IdP variant tolerance is then
//                                 implicit — Okta/Entra/Google all parse
//                                 to the same shape)
//     - parseTagValue/parseAttributeValue: false (preserve raw strings;
//                                                 we cast explicitly)
//
//   Layer 4 — post-parse depth walk. Cap at 20 levels of nesting. Even
//   without entity expansion, a deeply nested document can exhaust
//   stack on subsequent processing.
//
//   Layer 5 — semantic navigation. Require EntityDescriptor with an
//   entityID, an IDPSSODescriptor child, a signing KeyDescriptor, and
//   at least one X509Certificate inside.
//
//   Layer 6 — cert validation. Hand off the first signing cert to
//   `validateSigningCert` which does the cryptographic checks (not
//   yet valid, expired, weak alg, weak key).
//
// Any single layer's rejection short-circuits and returns a typed
// error code; no partial successes.
//
// IMPORTANT: this module's job ends at "we have a parsed, structurally-
// valid IdP metadata document with a usable signing cert". It does NOT
// verify a `<ds:Signature>` over the metadata itself — that's a separate
// concern and out of scope for this commit. (The metadata signature is
// the IdP signing the metadata; the cert we extract here is what the
// IdP will use to sign SAML responses.)

import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  validateSigningCert,
  type CertValidationResult,
} from './cert-validation'
import { inferIdpType, type IdPType } from './idp-type-heuristic'

// ─── Public constants ──────────────────────────────────────────────────

/** Hard cap on input XML size — defeats compression-bomb / megabyte attacks. */
export const SAFE_XML_MAX_BYTES = 1_000_000

/** Hard cap on parsed object nesting depth — defeats deeply-nested attacks. */
export const SAFE_XML_MAX_DEPTH = 20

/**
 * fast-xml-parser configuration used for ALL SAML metadata parsing.
 * Exported so test code can reuse the exact same options when crafting
 * fixtures for negative cases.
 */
export const SAFE_XML_PARSER_OPTIONS = {
  // Disable entity expansion: defeats XXE (file://, http://) and
  // billion-laughs / quadratic-blowup nested-entity attacks.
  processEntities: false,

  // We need attributes (use="signing", Algorithm="...", Binding="...").
  ignoreAttributes: false,
  attributeNamePrefix: '@_',

  // Strip namespace prefixes so Okta's <md:EntityDescriptor> and
  // Google's default-namespace <EntityDescriptor> both parse to the
  // same key. Multi-IdP variant tolerance is then automatic.
  removeNSPrefix: true,

  // Treat all values as strings; we cast explicitly where needed.
  parseTagValue: false,
  parseAttributeValue: false,

  // Drop XML comments — never relevant for SAML metadata, and a
  // surface for content-type confusion attacks.
  commentPropName: false,

  // No special CDATA handling — values inside CDATA become regular
  // string content, not a separate property.
  cdataPropName: false,
} as const

// ─── Pre-parse probes ──────────────────────────────────────────────────

const DOCTYPE_PROBE = /<!DOCTYPE\b/i
const ENTITY_PROBE = /<!ENTITY\b/i
// Match any `<?...` that isn't the canonical XML declaration `<?xml`.
// We DO NOT use a lookbehind here because some Node versions in
// transpilation pipelines have trouble with sticky-flag combinations.
const PROC_INST_PROBE = /<\?(?!xml\b)/i

// ─── Public types ──────────────────────────────────────────────────────

export type ParseSamlMetadataResult =
  | {
      ok: false
      errorCode:
        | 'OVERSIZED'
        | 'DOCTYPE_FORBIDDEN'
        | 'ENTITY_FORBIDDEN'
        | 'PROCESSING_INSTRUCTION_FORBIDDEN'
        | 'INVALID_XML'
        | 'XML_TOO_DEEP'
        | 'NOT_SAML_METADATA'
        | 'NO_IDP_DESCRIPTOR'
        | 'NO_SIGNING_CERT'
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
      entity_id: string
      idp_type: IdPType
      /** Preferred SSO endpoint: HTTP-Redirect binding if present, else HTTP-POST. */
      sso_url: string | null
      /** Explicit HTTP-POST binding if separately advertised. */
      sso_url_post: string | null
      /** Single Logout endpoint, if advertised. */
      slo_url: string | null
      /** Validated signing cert metadata. */
      cert: Extract<CertValidationResult, { ok: true }>
      /**
       * True when the IDPSSODescriptor advertised more than one signing
       * X509Certificate. Used by the admin UI to surface a "rotation in
       * progress?" hint without making it a security decision.
       */
      extra_signing_certs_present: boolean
    }

// ─── Internal types ────────────────────────────────────────────────────

// fast-xml-parser returns dynamically-shaped objects. We isolate the
// `unknown` casts to a few small navigation helpers so the security
// checks themselves stay typed.
type XmlNode = Record<string, unknown>

// ─── Public function ───────────────────────────────────────────────────

/**
 * Parse SAML 2.0 IdP metadata XML and return validated extracted fields.
 *
 * @param xml - Metadata document text (already decoded to a UTF-8 string).
 *   Callers fetching from a URL should pass the bytes through
 *   `Buffer.toString('utf-8')` first.
 */
export function parseSamlMetadata(xml: string): ParseSamlMetadataResult {
  // ── Layer 1: pre-parse byte scan ─────────────────────────────────
  if (xml.length > SAFE_XML_MAX_BYTES) {
    return {
      ok: false,
      errorCode: 'OVERSIZED',
      error: `XML exceeds ${SAFE_XML_MAX_BYTES} bytes`,
    }
  }
  if (DOCTYPE_PROBE.test(xml)) {
    return {
      ok: false,
      errorCode: 'DOCTYPE_FORBIDDEN',
      error: 'XML DOCTYPE declarations are not permitted (XXE defense)',
    }
  }
  if (ENTITY_PROBE.test(xml)) {
    return {
      ok: false,
      errorCode: 'ENTITY_FORBIDDEN',
      error: 'XML entity declarations are not permitted (XXE defense)',
    }
  }
  if (PROC_INST_PROBE.test(xml)) {
    return {
      ok: false,
      errorCode: 'PROCESSING_INSTRUCTION_FORBIDDEN',
      error: 'XML processing instructions other than <?xml are not permitted',
    }
  }

  // ── Layer 2: structural validator ────────────────────────────────
  const validation = XMLValidator.validate(xml, {
    allowBooleanAttributes: false,
  })
  if (validation !== true) {
    const msg =
      typeof validation === 'object' && validation && 'err' in validation
        ? (validation.err as { msg?: string }).msg ?? 'invalid'
        : 'invalid'
    return {
      ok: false,
      errorCode: 'INVALID_XML',
      error: `Malformed XML: ${msg}`,
    }
  }

  // ── Layer 3: parse ──────────────────────────────────────────────
  let parsed: unknown
  try {
    const parser = new XMLParser(SAFE_XML_PARSER_OPTIONS)
    parsed = parser.parse(xml)
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INVALID_XML',
      error: `XML parse failed: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }

  // ── Layer 4: depth walk ─────────────────────────────────────────
  if (!walkDepth(parsed, 0)) {
    return {
      ok: false,
      errorCode: 'XML_TOO_DEEP',
      error: `XML exceeds ${SAFE_XML_MAX_DEPTH} levels of nesting`,
    }
  }

  // ── Layer 5: semantic navigation ────────────────────────────────
  if (!isObject(parsed)) {
    return {
      ok: false,
      errorCode: 'NOT_SAML_METADATA',
      error: 'XML root is not an object',
    }
  }

  const entityDescriptor = parsed['EntityDescriptor']
  if (!isObject(entityDescriptor)) {
    return {
      ok: false,
      errorCode: 'NOT_SAML_METADATA',
      error: 'Root element is not EntityDescriptor',
    }
  }

  const entityId = readStringAttr(entityDescriptor, '@_entityID')
  if (!entityId) {
    return {
      ok: false,
      errorCode: 'NOT_SAML_METADATA',
      error: 'EntityDescriptor is missing entityID attribute',
    }
  }

  const idpDescriptor = entityDescriptor['IDPSSODescriptor']
  if (!isObject(idpDescriptor)) {
    return {
      ok: false,
      errorCode: 'NO_IDP_DESCRIPTOR',
      error:
        'No IDPSSODescriptor found — this metadata describes only an SP, not an IdP',
    }
  }

  // SSO endpoints (HTTP-Redirect preferred for compatibility, HTTP-POST
  // is the fallback when the IdP omits Redirect).
  const ssoServices = arrayify(idpDescriptor['SingleSignOnService'])
  const httpRedirect = ssoServices.find(
    (s) =>
      isObject(s) &&
      readStringAttr(s, '@_Binding') ===
        'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
  )
  const httpPost = ssoServices.find(
    (s) =>
      isObject(s) &&
      readStringAttr(s, '@_Binding') ===
        'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
  )
  const ssoUrl =
    (isObject(httpRedirect) && readStringAttr(httpRedirect, '@_Location')) ||
    (isObject(httpPost) && readStringAttr(httpPost, '@_Location')) ||
    null
  const ssoUrlPost =
    (isObject(httpPost) && readStringAttr(httpPost, '@_Location')) || null

  const sloServices = arrayify(idpDescriptor['SingleLogoutService'])
  const sloUrl =
    sloServices
      .map((s) => (isObject(s) ? readStringAttr(s, '@_Location') : null))
      .find((u): u is string => typeof u === 'string' && u.length > 0) ?? null

  // ── Layer 6: signing cert extraction + validation ────────────────
  const keyDescriptors = arrayify(idpDescriptor['KeyDescriptor'])
  // A KeyDescriptor with no `use` attribute is implicitly both signing
  // and encryption per the SAML metadata spec, so we accept it here.
  const signingDescriptors = keyDescriptors.filter((kd) => {
    if (!isObject(kd)) return false
    const use = readStringAttr(kd, '@_use')
    return use === undefined || use === 'signing'
  })

  if (signingDescriptors.length === 0) {
    return {
      ok: false,
      errorCode: 'NO_SIGNING_CERT',
      error: 'No signing KeyDescriptor found in IDPSSODescriptor',
    }
  }

  const allSigningCerts: string[] = []
  for (const kd of signingDescriptors) {
    if (!isObject(kd)) continue
    const keyInfo = kd['KeyInfo']
    if (!isObject(keyInfo)) continue
    for (const x509Data of arrayify(keyInfo['X509Data'])) {
      if (!isObject(x509Data)) continue
      for (const cert of arrayify(x509Data['X509Certificate'])) {
        if (typeof cert === 'string' && cert.trim().length > 0) {
          allSigningCerts.push(cert)
        }
      }
    }
  }

  if (allSigningCerts.length === 0) {
    return {
      ok: false,
      errorCode: 'NO_SIGNING_CERT',
      error: 'No X509Certificate found in signing KeyDescriptor',
    }
  }

  // First signing cert wins. Multi-cert metadata is common during a
  // rotation window: the IdP advertises both old and new certs and
  // signs with whichever it chooses on a per-response basis. We record
  // `extra_signing_certs_present` so the admin UI can hint at it.
  const certResult = validateSigningCert(allSigningCerts[0]!)
  if (!certResult.ok) {
    return certResult
  }

  return {
    ok: true,
    entity_id: entityId,
    idp_type: inferIdpType(entityId, ssoUrl),
    sso_url: ssoUrl,
    sso_url_post: ssoUrlPost,
    slo_url: sloUrl,
    cert: certResult,
    extra_signing_certs_present: allSigningCerts.length > 1,
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

function isObject(v: unknown): v is XmlNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Coerce fast-xml-parser's "single-or-array" outputs to always-array.
 * fast-xml-parser returns either a single object or an array of objects
 * depending on whether the element appears once or multiple times.
 */
function arrayify(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Read a string attribute from an XML node by `@_<name>` key. Returns
 * undefined if the attribute is absent or non-string.
 */
function readStringAttr(node: XmlNode, key: string): string | undefined {
  const v = node[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * Walk the parsed tree depth-first, returning false if depth exceeds
 * `SAFE_XML_MAX_DEPTH`. Returns true otherwise. Iterative-recursive
 * style; small recursion is fine because we cap at 20.
 */
function walkDepth(node: unknown, depth: number): boolean {
  if (depth > SAFE_XML_MAX_DEPTH) return false
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) {
      if (!walkDepth(value, depth + 1)) return false
    }
  }
  return true
}
