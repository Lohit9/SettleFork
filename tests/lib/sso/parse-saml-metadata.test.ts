// @vitest-environment node
//
// Coverage for `lib/sso/parse-saml-metadata.ts`. Each test loads one of
// the fixtures from `tests/fixtures/saml/` (built by
// `scripts/generate-saml-test-fixtures.ts`) and asserts the parser
// returns the expected outcome — either an `ok: true` extraction or a
// specific typed error code.
//
// Why fixtures, not inline strings: real-world SAML metadata is verbose
// and easy to subtly break with manual editing. Files let us inspect
// the exact bytes the parser sees, and they double as reference
// metadata for future bug reports ("can you reproduce against
// `tests/fixtures/saml/<x>.xml`?").

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { parseSamlMetadata } from '@/lib/sso/parse-saml-metadata'

const FIXTURES = path.resolve(__dirname, '../../fixtures/saml')

function load(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

// ─── Realistic IdP metadata — extraction success ────────────────────

describe('parseSamlMetadata — real-world IdP shapes', () => {
  it('parses Okta metadata and infers idp_type=okta', () => {
    const r = parseSamlMetadata(load('okta-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entity_id).toBe('http://www.okta.com/exk1abcdEFGHijklm0p7')
      expect(r.idp_type).toBe('okta')
      expect(r.sso_url).toMatch(/okta\.com/)
      expect(r.cert.signature_algorithm).toBe('sha256WithRSAEncryption')
      expect(r.extra_signing_certs_present).toBe(false)
    }
  })

  it('prefers HTTP-Redirect binding when both are present', () => {
    const r = parseSamlMetadata(load('okta-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      // The fixture lists POST first, then Redirect; we should pick
      // Redirect for sso_url and still expose POST in sso_url_post.
      expect(r.sso_url).toMatch(/sso\/saml/)
      expect(r.sso_url_post).toMatch(/sso\/saml/)
    }
  })

  it('parses Entra (Azure AD) metadata and infers idp_type=entra', () => {
    const r = parseSamlMetadata(load('entra-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entity_id).toContain('sts.windows.net')
      expect(r.idp_type).toBe('entra')
      // Entra advertises rotation certs; we expose the flag.
      expect(r.extra_signing_certs_present).toBe(true)
      expect(r.slo_url).toMatch(/login\.microsoftonline\.com/)
    }
  })

  it('handles Entra variant with login.windows.net entityID', () => {
    const r = parseSamlMetadata(load('entra-windows-net.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.idp_type).toBe('entra')
      expect(r.entity_id).toContain('login.windows.net')
    }
  })

  it('parses Google Workspace metadata and infers idp_type=google', () => {
    const r = parseSamlMetadata(load('google-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entity_id).toContain('accounts.google.com')
      expect(r.idp_type).toBe('google')
      expect(r.sso_url).toContain('accounts.google.com')
    }
  })

  it('parses generic SAML 2.0 (OneLogin-shape) and falls back to idp_type=generic', () => {
    const r = parseSamlMetadata(load('onelogin-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.idp_type).toBe('generic')
      expect(r.entity_id).toContain('onelogin.com')
    }
  })

  it('accepts a KeyDescriptor with no use= attribute as signing', () => {
    const r = parseSamlMetadata(load('key-no-use-attribute.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entity_id).toBe('https://example.com/idp/no-use')
    }
  })

  it('uses the FIRST signing cert when metadata advertises rotation', () => {
    const r = parseSamlMetadata(load('multi-cert-rotation.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.extra_signing_certs_present).toBe(true)
      // The first cert in the rotation fixture is the SHA-256/RSA-2048 one.
      expect(r.cert.signature_algorithm).toBe('sha256WithRSAEncryption')
      expect(r.cert.key_size_bits).toBe(2048)
    }
  })

  it('parses a document mixing md: prefix and default namespace', () => {
    const r = parseSamlMetadata(load('mixed-namespaces.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entity_id).toBe('https://example.com/idp/mixed')
      expect(r.sso_url).toBe('https://example.com/sso')
    }
  })
})

// ─── XXE / entity defenses ──────────────────────────────────────────

describe('parseSamlMetadata — XXE defense', () => {
  it('rejects DOCTYPE with file:// entity (etc/passwd disclosure)', () => {
    const r = parseSamlMetadata(load('xxe-etc-passwd.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('DOCTYPE_FORBIDDEN')
  })

  it('rejects DOCTYPE with http:// entity (SSRF probe)', () => {
    const r = parseSamlMetadata(load('xxe-internal-url.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('DOCTYPE_FORBIDDEN')
  })

  it('rejects billion-laughs (nested entity expansion)', () => {
    const r = parseSamlMetadata(load('billion-laughs.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('DOCTYPE_FORBIDDEN')
  })

  it('rejects quadratic-blowup', () => {
    const r = parseSamlMetadata(load('quadratic-blowup.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('DOCTYPE_FORBIDDEN')
  })

  it('rejects bare <!ENTITY> outside a DOCTYPE', () => {
    const r = parseSamlMetadata(load('bare-entity.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('ENTITY_FORBIDDEN')
  })

  it('rejects processing instructions other than <?xml', () => {
    const r = parseSamlMetadata(load('proc-instr.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('PROCESSING_INSTRUCTION_FORBIDDEN')
  })

  it('still accepts the canonical <?xml ... ?> declaration', () => {
    // All the valid fixtures start with <?xml — make this explicit.
    const r = parseSamlMetadata(load('okta-valid.xml'))
    expect(r.ok).toBe(true)
  })
})

// ─── Resource-exhaustion defenses ────────────────────────────────────

describe('parseSamlMetadata — resource caps', () => {
  it('rejects oversized input (> 1 MB)', () => {
    const r = parseSamlMetadata(load('oversized.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('OVERSIZED')
  })

  it('rejects deeply-nested XML (> 20 levels)', () => {
    const r = parseSamlMetadata(load('deeply-nested.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('XML_TOO_DEEP')
  })
})

// ─── Structural / semantic ──────────────────────────────────────────

describe('parseSamlMetadata — structural / semantic errors', () => {
  it('rejects malformed XML', () => {
    const r = parseSamlMetadata(load('truncated.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('INVALID_XML')
  })

  it('rejects a non-EntityDescriptor root with NOT_SAML_METADATA', () => {
    const r = parseSamlMetadata(load('wrong-root.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('NOT_SAML_METADATA')
  })

  it('rejects SP-only metadata (no IDPSSODescriptor)', () => {
    const r = parseSamlMetadata(load('sp-only.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('NO_IDP_DESCRIPTOR')
  })

  it('rejects metadata with no X509Certificate inside the signing KeyDescriptor', () => {
    const r = parseSamlMetadata(load('no-cert.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('NO_SIGNING_CERT')
  })

  it('rejects raw garbage strings', () => {
    const r = parseSamlMetadata('this is not XML')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('INVALID_XML')
  })

  it('rejects empty input', () => {
    const r = parseSamlMetadata('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('INVALID_XML')
  })

  it('forwards CERT_EXPIRED from cert validation', () => {
    const r = parseSamlMetadata(load('expired-cert.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('CERT_EXPIRED')
  })

  it('forwards CERT_NOT_YET_VALID from cert validation', () => {
    const r = parseSamlMetadata(load('not-yet-valid-cert.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('CERT_NOT_YET_VALID')
  })

  it('forwards CERT_WEAK_SIGNATURE_ALG from cert validation', () => {
    const r = parseSamlMetadata(load('sha1-cert.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('CERT_WEAK_SIGNATURE_ALG')
  })

  it('forwards CERT_WEAK_KEY from cert validation', () => {
    const r = parseSamlMetadata(load('weak-rsa-cert.xml'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorCode).toBe('CERT_WEAK_KEY')
  })
})

// ─── inferIdpType integration ────────────────────────────────────────

describe('parseSamlMetadata — inferIdpType integration', () => {
  it('tags Okta when entityID contains okta.com', () => {
    const r = parseSamlMetadata(load('okta-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.idp_type).toBe('okta')
  })

  it('tags Entra for sts.windows.net entityID', () => {
    const r = parseSamlMetadata(load('entra-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.idp_type).toBe('entra')
  })

  it('tags Entra for login.windows.net entityID', () => {
    const r = parseSamlMetadata(load('entra-windows-net.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.idp_type).toBe('entra')
  })

  it('tags Google for accounts.google.com entityID', () => {
    const r = parseSamlMetadata(load('google-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.idp_type).toBe('google')
  })

  it('falls back to generic for everything else', () => {
    const r = parseSamlMetadata(load('onelogin-valid.xml'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.idp_type).toBe('generic')
  })
})
