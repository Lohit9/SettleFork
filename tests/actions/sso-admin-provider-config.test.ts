// @vitest-environment node
//
// Integration tests for `lib/actions/sso-admin-provider-config.ts`. We
// mock every external dependency (GoTrue, safeFetch, Upstash, Supabase,
// audit, requireOrgAdmin) so the suite runs hermetically in CI and
// exercises the orchestrator's branches deterministically.
//
// Coverage matrix (Mini-D7 decision tree + ancillary error paths):
//
//   Configure path
//   ──────────────
//   1.  XML, no existing provider                       → action='created'
//   2.  URL, no existing provider                       → action='created'
//   3.  Re-configure same fingerprint, same entity_id   → action='no_op'
//   4.  Same entity_id, new fingerprint (cert rotation) → action='updated_in_place'
//   5.  New entity_id without confirm flag              → ENTITY_ID_CHANGED
//   6.  New entity_id WITH confirm flag                 → action='replaced'
//   7.  Replacement: CAS swap fails (concurrent writer) → DB_ERROR + rollback DELETE
//
//   Gates
//   ─────
//   8.  Feature flag off                                → NOT_AVAILABLE
//   9.  Feature flag on, org NOT in allowlist           → NOT_AVAILABLE
//   10. Auth gate rejects                               → NOT_AUTHORIZED
//   11. URL path: rate limit hit                        → RATE_LIMITED
//
//   Validation forwarded from primitives
//   ────────────────────────────────────
//   12. XXE DOCTYPE in XML                              → DOCTYPE_FORBIDDEN
//   13. URL resolves to private IP                      → PRIVATE_IP
//   14. Cert expired                                    → CERT_EXPIRED
//
//   Failure / rollback paths
//   ────────────────────────
//   15. GoTrue POST fails                               → GOTRUE_ERROR, no DB write
//   16. DB insert fails after GoTrue POST succeeds      → rollback DELETE called
//   17. Password-only users present, no force_override  → PASSWORD_USERS_EXIST
//   18. force_override bypasses password check          → success
//
// Mock pattern: vi.hoisted constants + vi.mock factories. The supabase
// admin client is mocked with a fluent chainable so individual tests
// can override .maybeSingle(), .single(), and .insert/.update return
// values per-test.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─────────────────────────────────────────────────────────────────────
// Hoisted mock state
// ─────────────────────────────────────────────────────────────────────

const {
  gotrueAdminRequestMock,
  safeFetchMetadataMock,
  checkRateLimitMock,
  requireOrgAdminMock,
  emitSsoAuditEventMock,
  isMetadataUploadEnabledForOrgMock,
  supabaseFromMock,
  supabaseRpcMock,
  getSPUrlsMock,
} = vi.hoisted(() => {
  return {
    gotrueAdminRequestMock: vi.fn(),
    safeFetchMetadataMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
    requireOrgAdminMock: vi.fn(),
    emitSsoAuditEventMock: vi.fn(),
    isMetadataUploadEnabledForOrgMock: vi.fn(),
    supabaseFromMock: vi.fn(),
    supabaseRpcMock: vi.fn(),
    getSPUrlsMock: vi.fn(),
  }
})

vi.mock('@/lib/sso/gotrue-admin', () => ({
  gotrueAdminRequest: gotrueAdminRequestMock,
}))
vi.mock('@/lib/security/safe-fetch', () => ({
  safeFetchMetadata: safeFetchMetadataMock,
}))
vi.mock('@/lib/rate-limit/upstash', () => ({
  checkRateLimit: checkRateLimitMock,
}))
vi.mock('@/lib/auth/require-org-role', () => ({
  requireOrgAdmin: requireOrgAdminMock,
}))
vi.mock('@/lib/actions/sso-audit', () => ({
  emitSsoAuditEvent: emitSsoAuditEventMock,
}))
vi.mock('@/lib/sso/admin-metadata-upload-allowlist', () => ({
  isMetadataUploadEnabledForOrg: isMetadataUploadEnabledForOrgMock,
}))
vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: {
    from: supabaseFromMock,
    rpc: supabaseRpcMock,
  },
}))
vi.mock('@/lib/actions/sso', () => ({
  getSPUrls: getSPUrlsMock,
}))

// ─────────────────────────────────────────────────────────────────────
// Imports of the SUT — must come AFTER vi.mock above
// ─────────────────────────────────────────────────────────────────────

import {
  configureOrgSsoProviderFromXml,
  configureOrgSsoProviderFromUrl,
} from '@/lib/actions/sso-admin-provider-config'

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const FIXTURE_DIR = resolve(__dirname, '../fixtures/saml')
const OKTA_VALID_XML = readFileSync(
  resolve(FIXTURE_DIR, 'okta-valid.xml'),
  'utf8',
)
const ENTRA_VALID_XML = readFileSync(
  resolve(FIXTURE_DIR, 'entra-valid.xml'),
  'utf8',
)
const XXE_XML = readFileSync(
  resolve(FIXTURE_DIR, 'xxe-etc-passwd.xml'),
  'utf8',
)
const EXPIRED_XML = readFileSync(
  resolve(FIXTURE_DIR, 'expired-cert.xml'),
  'utf8',
)

const ORG_ID = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb'
const NEW_GOTRUE_ID = 'ccccccc1-3333-3333-3333-cccccccccccc'
const OLD_GOTRUE_ID = 'ccccccc0-3333-3333-3333-cccccccccccc'

const SP_URLS = {
  acsUrl: 'https://test.supabase.co/auth/v1/sso/saml/acs',
  spEntityId: 'https://test.supabase.co/auth/v1/sso/saml/metadata',
}

// Build a fluent supabase chain stub. Default returns a `maybeSingle()`
// of `{ data: null, error: null }` (no existing provider) and `insert`
// / `update` / `single` / `delete` whose return value is set per-test
// via `setExisting` / `setInsertResult` / `setUpdateResult` helpers.
//
// The tests use `setFromBehavior` to thread per-table behavior — e.g.
// `sso_providers` returns the configured maybeSingle value, while
// `organizations` is permissive (the org-flag flip after a successful
// insert).
interface FromBehavior {
  selectMaybeSingle?: { data: unknown; error: unknown }
  insertSingle?: { data: unknown; error: unknown }
  updateMaybeSingle?: { data: unknown; error: unknown }
  updateEqEqMaybeSingle?: { data: unknown; error: unknown }
  // For organizations table flip
  updateEqOk?: { error: unknown }
}

const fromBehavior: Record<string, FromBehavior> = {}

function setFromBehavior(table: string, behavior: FromBehavior) {
  fromBehavior[table] = { ...(fromBehavior[table] ?? {}), ...behavior }
}

function clearFromBehavior() {
  for (const k of Object.keys(fromBehavior)) delete fromBehavior[k]
}

function buildFromMock() {
  supabaseFromMock.mockImplementation((table: string) => {
    const beh = fromBehavior[table] ?? {}

    // SELECT chain: .from(table).select('*').eq(col, val).maybeSingle()
    const selectChain = {
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () =>
          beh.selectMaybeSingle ?? { data: null, error: null },
        ),
      })),
    }

    // INSERT chain: .insert({...}).select('*').single()
    const insertChain = vi.fn((..._args: unknown[]) => ({
      select: vi.fn(() => ({
        single: vi.fn(async () =>
          beh.insertSingle ?? {
            data: { id: 'inserted-row' },
            error: null,
          },
        ),
      })),
    }))

    // UPDATE chain: .update({...}).eq('org_id', ...).eq(...).select('*').maybeSingle() | .single()
    //  — also: .update({...}).eq('id', ...).select('*').single() (in-place)
    //  — also: .update({...}).eq('id', orgId) (org flag flip — no select)
    const updateChain = vi.fn((..._args: unknown[]) => {
      // Distinguish between the org flag flip (.update().eq('id', x))
      // and the single-eq cases. We let `then` / `await` resolve to the
      // updateEqOk shape; the chained `.eq().select().single()` uses
      // updateEqEqMaybeSingle (two-eq, e.g. CAS swap) or
      // updateMaybeSingle (one-eq, e.g. in-place update).
      const eqLevel1 = vi.fn((_col: string, _val: unknown) => {
        const eqLevel2 = vi.fn((_col2: string, _val2: unknown) => ({
          select: vi.fn(() => ({
            single: vi.fn(async () =>
              beh.updateEqEqMaybeSingle ?? {
                data: { id: 'updated-row' },
                error: null,
              },
            ),
            maybeSingle: vi.fn(async () =>
              beh.updateEqEqMaybeSingle ?? {
                data: { id: 'updated-row' },
                error: null,
              },
            ),
          })),
        }))
        const selectAfterOneEq = {
          select: vi.fn(() => ({
            single: vi.fn(async () =>
              beh.updateMaybeSingle ?? {
                data: { id: 'updated-row' },
                error: null,
              },
            ),
            maybeSingle: vi.fn(async () =>
              beh.updateMaybeSingle ?? {
                data: { id: 'updated-row' },
                error: null,
              },
            ),
          })),
        }
        // The org-flag flip is `.update({...}).eq('id', orgId)` and
        // is awaited directly — we satisfy it via `then`.
        const thenable = {
          then: (onResolve: (v: { error: unknown }) => unknown) =>
            Promise.resolve(beh.updateEqOk ?? { error: null }).then(onResolve),
        }
        return Object.assign(thenable, {
          eq: eqLevel2,
          select: selectAfterOneEq.select,
        })
      })
      return { eq: eqLevel1 }
    })

    return {
      select: vi.fn(() => selectChain),
      insert: insertChain,
      update: updateChain,
    }
  })
}

const PARSED_OKTA_FINGERPRINT_PLACEHOLDER = '__from_real_parser__'

// ─────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  gotrueAdminRequestMock.mockReset()
  safeFetchMetadataMock.mockReset()
  checkRateLimitMock.mockReset()
  requireOrgAdminMock.mockReset()
  emitSsoAuditEventMock.mockReset()
  isMetadataUploadEnabledForOrgMock.mockReset()
  supabaseFromMock.mockReset()
  supabaseRpcMock.mockReset()
  getSPUrlsMock.mockReset()

  // Sensible defaults: feature on, auth ok, no rate limit, sp urls set,
  // password count zero, no existing provider.
  isMetadataUploadEnabledForOrgMock.mockReturnValue(true)
  requireOrgAdminMock.mockResolvedValue({
    ok: true,
    userId: USER_ID,
    role: 'admin',
  })
  checkRateLimitMock.mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 60_000,
    limit: 5,
  })
  getSPUrlsMock.mockResolvedValue(SP_URLS)
  supabaseRpcMock.mockResolvedValue({ data: 0, error: null })

  clearFromBehavior()
  // Default: no existing sso_providers row, insert succeeds with the
  // payload we passed in (echo via a captured object so tests can
  // assert specific column values were written).
  setFromBehavior('sso_providers', {
    selectMaybeSingle: { data: null, error: null },
    insertSingle: { data: { id: 'new-row' }, error: null },
  })
  setFromBehavior('organizations', { updateEqOk: { error: null } })
  buildFromMock()

  emitSsoAuditEventMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// Helper: shape an SSOProvider-like row for `selectMaybeSingle`.
function existingProviderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'existing-row',
    org_id: ORG_ID,
    supabase_provider_id: OLD_GOTRUE_ID,
    idp_type: 'okta',
    entity_id: 'http://www.okta.com/exk1xxxxx',
    metadata_url: null,
    metadata_xml: '<existing/>',
    acs_url: SP_URLS.acsUrl,
    sp_entity_id: SP_URLS.spEntityId,
    attribute_mapping: { keys: {} },
    cert_fingerprint_sha256: 'oldfingerprint00000000000000000000000000000000000000000000000000',
    cert_subject: 'CN=old',
    cert_not_before: '2020-01-01T00:00:00Z',
    cert_not_after: '2099-01-01T00:00:00Z',
    cert_signature_algorithm: 'sha256WithRSAEncryption',
    created_at: '2020-01-01T00:00:00Z',
    created_by: USER_ID,
    updated_at: '2020-01-01T00:00:00Z',
    ...overrides,
  }
}

// We rely on the real parseSamlMetadata inside the SUT — it's NOT
// mocked here because the test's intent is end-to-end via the
// orchestrator. To keep the tests focused on orchestration, we read
// fingerprint from the real parser by feeding the same XML through it
// during setup.
import { parseSamlMetadata } from '@/lib/sso/parse-saml-metadata'

const parsedOkta = parseSamlMetadata(OKTA_VALID_XML)
const parsedEntra = parseSamlMetadata(ENTRA_VALID_XML)
if (!parsedOkta.ok) throw new Error(`Okta fixture failed to parse: ${parsedOkta.error}`)
if (!parsedEntra.ok) throw new Error(`Entra fixture failed to parse: ${parsedEntra.error}`)

const OKTA_FINGERPRINT = parsedOkta.cert.fingerprint_sha256
const OKTA_ENTITY_ID = parsedOkta.entity_id
const ENTRA_ENTITY_ID = parsedEntra.entity_id

// Sanity: ensure the placeholder constant did its purpose (we already
// have the real fingerprint, but we keep the placeholder ref so the
// constant block stays expressive in source review).
void PARSED_OKTA_FINGERPRINT_PLACEHOLDER

// ─────────────────────────────────────────────────────────────────────
// 1. Happy path — XML, no existing provider
// ─────────────────────────────────────────────────────────────────────

describe('configureOrgSsoProviderFromXml — create from XML', () => {
  it('creates a new provider, emits sso.provider.configured with source=metadata_xml', async () => {
    gotrueAdminRequestMock.mockResolvedValueOnce({ id: NEW_GOTRUE_ID })
    setFromBehavior('sso_providers', {
      insertSingle: {
        data: existingProviderRow({
          supabase_provider_id: NEW_GOTRUE_ID,
          cert_fingerprint_sha256: OKTA_FINGERPRINT,
          entity_id: OKTA_ENTITY_ID,
          idp_type: 'okta',
        }),
        error: null,
      },
    })

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('created')
    expect(result.cert_fingerprint_sha256).toBe(OKTA_FINGERPRINT)
    expect(result.entity_id).toBe(OKTA_ENTITY_ID)

    // GoTrue POST called exactly once with the XML body.
    expect(gotrueAdminRequestMock).toHaveBeenCalledTimes(1)
    expect(gotrueAdminRequestMock).toHaveBeenCalledWith(
      'POST',
      '/admin/sso/providers',
      expect.objectContaining({ type: 'saml', metadata_xml: OKTA_VALID_XML }),
    )

    // Audit emit with source=metadata_xml, has_metadata_url=false.
    expect(emitSsoAuditEventMock).toHaveBeenCalledWith(
      'sso.provider.configured',
      expect.objectContaining({
        actorUserId: USER_ID,
        orgId: ORG_ID,
        metadata: expect.objectContaining({
          source: 'metadata_xml',
          has_metadata_url: false,
          cert_fingerprint_sha256: OKTA_FINGERPRINT,
          entity_id: OKTA_ENTITY_ID,
        }),
      }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. Happy path — URL fetch, then create
// ─────────────────────────────────────────────────────────────────────

describe('configureOrgSsoProviderFromUrl — create from URL', () => {
  it('fetches via safeFetchMetadata, then creates provider with source=metadata_url', async () => {
    safeFetchMetadataMock.mockResolvedValueOnce({
      ok: true,
      bytes: Buffer.from(OKTA_VALID_XML, 'utf8'),
      contentType: 'application/xml',
      finalUrl: 'https://idp.example.com/metadata',
    })
    gotrueAdminRequestMock.mockResolvedValueOnce({ id: NEW_GOTRUE_ID })
    setFromBehavior('sso_providers', {
      insertSingle: {
        data: existingProviderRow({
          supabase_provider_id: NEW_GOTRUE_ID,
          cert_fingerprint_sha256: OKTA_FINGERPRINT,
          entity_id: OKTA_ENTITY_ID,
          metadata_url: 'https://idp.example.com/metadata',
        }),
        error: null,
      },
    })

    const result = await configureOrgSsoProviderFromUrl(
      ORG_ID,
      'https://idp.example.com/metadata',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('created')

    expect(safeFetchMetadataMock).toHaveBeenCalledWith(
      'https://idp.example.com/metadata',
    )
    expect(gotrueAdminRequestMock).toHaveBeenCalledTimes(1)

    // Audit must include source=metadata_url + has_metadata_url=true,
    // and MUST NOT include the raw metadata_url value (Mini-D13).
    const auditCall = emitSsoAuditEventMock.mock.calls[0]
    expect(auditCall[0]).toBe('sso.provider.configured')
    const metadata = auditCall[1].metadata as Record<string, unknown>
    expect(metadata.source).toBe('metadata_url')
    expect(metadata.has_metadata_url).toBe(true)
    expect(metadata.metadata_url).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. Idempotent re-upload — same fingerprint, same entity_id
// ─────────────────────────────────────────────────────────────────────

describe('configureOrgSsoProviderFromXml — no-op on identical re-upload', () => {
  it('returns action=no_op without calling GoTrue or emitting audit', async () => {
    setFromBehavior('sso_providers', {
      selectMaybeSingle: {
        data: existingProviderRow({
          cert_fingerprint_sha256: OKTA_FINGERPRINT,
          entity_id: OKTA_ENTITY_ID,
          idp_type: 'okta',
        }),
        error: null,
      },
    })

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('no_op')
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
    expect(emitSsoAuditEventMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. Cert rotation — same entity_id, new fingerprint → updated_in_place
// ─────────────────────────────────────────────────────────────────────

describe('configureOrgSsoProviderFromXml — cert rotation (same entity, new cert)', () => {
  it('PUTs to GoTrue and emits sso.provider.updated with action=updated_in_place', async () => {
    setFromBehavior('sso_providers', {
      selectMaybeSingle: {
        data: existingProviderRow({
          entity_id: OKTA_ENTITY_ID,
          // Different fingerprint forces the in-place branch.
          cert_fingerprint_sha256: 'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111',
        }),
        error: null,
      },
      updateMaybeSingle: {
        data: existingProviderRow({
          entity_id: OKTA_ENTITY_ID,
          cert_fingerprint_sha256: OKTA_FINGERPRINT,
        }),
        error: null,
      },
    })
    gotrueAdminRequestMock.mockResolvedValueOnce(undefined) // PUT

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('updated_in_place')

    expect(gotrueAdminRequestMock).toHaveBeenCalledWith(
      'PUT',
      `/admin/sso/providers/${OLD_GOTRUE_ID}`,
      expect.objectContaining({ metadata_xml: OKTA_VALID_XML }),
    )

    const auditCall = emitSsoAuditEventMock.mock.calls[0]
    expect(auditCall[0]).toBe('sso.provider.updated')
    const md = auditCall[1].metadata as Record<string, unknown>
    expect(md.action).toBe('updated_in_place')
    expect(md.previous_cert_fingerprint_sha256).toBe(
      'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111',
    )
    expect(md.cert_fingerprint_sha256).toBe(OKTA_FINGERPRINT)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. Different entity_id, no confirm → ENTITY_ID_CHANGED
// ─────────────────────────────────────────────────────────────────────

describe('configureOrgSsoProviderFromXml — entity_id mismatch without confirm', () => {
  it('rejects with ENTITY_ID_CHANGED, no GoTrue calls', async () => {
    setFromBehavior('sso_providers', {
      selectMaybeSingle: {
        data: existingProviderRow({ entity_id: 'http://prev/entity' }),
        error: null,
      },
    })

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('ENTITY_ID_CHANGED')
    expect(result.details?.expected_entity_id).toBe('http://prev/entity')
    expect(result.details?.conflicting_entity_id).toBe(OKTA_ENTITY_ID)
    expect(result.details?.proposed_idp_type).toBe(parsedOkta.idp_type)
    expect(result.details?.proposed_cert_fingerprint_sha256).toBe(
      OKTA_FINGERPRINT,
    )
    expect(result.details?.proposed_cert_not_after).toBe(
      parsedOkta.cert.not_after,
    )
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 6. Different entity_id, with confirmReplaceEntityId → replaced
// ─────────────────────────────────────────────────────────────────────

describe('configureOrgSsoProviderFromXml — replacement (CAS-guarded swap)', () => {
  it('creates new GoTrue provider, swaps DB row, deletes old GoTrue provider', async () => {
    setFromBehavior('sso_providers', {
      selectMaybeSingle: {
        data: existingProviderRow({ entity_id: 'http://prev/entity' }),
        error: null,
      },
      // Two-eq update path is the CAS swap.
      updateEqEqMaybeSingle: {
        data: existingProviderRow({
          entity_id: OKTA_ENTITY_ID,
          supabase_provider_id: NEW_GOTRUE_ID,
          cert_fingerprint_sha256: OKTA_FINGERPRINT,
        }),
        error: null,
      },
    })
    gotrueAdminRequestMock
      .mockResolvedValueOnce({ id: NEW_GOTRUE_ID }) // POST new
      .mockResolvedValueOnce(undefined) // DELETE old

    const result = await configureOrgSsoProviderFromXml(
      ORG_ID,
      OKTA_VALID_XML,
      { confirmReplaceEntityId: true },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('replaced')

    expect(gotrueAdminRequestMock).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/admin/sso/providers',
      expect.objectContaining({ type: 'saml' }),
    )
    expect(gotrueAdminRequestMock).toHaveBeenNthCalledWith(
      2,
      'DELETE',
      `/admin/sso/providers/${OLD_GOTRUE_ID}`,
    )

    const auditCall = emitSsoAuditEventMock.mock.calls[0]
    expect(auditCall[0]).toBe('sso.provider.updated')
    const md = auditCall[1].metadata as Record<string, unknown>
    expect(md.action).toBe('replaced')
    expect(md.previous_entity_id).toBe('http://prev/entity')
    expect(md.previous_supabase_provider_id).toBe(OLD_GOTRUE_ID)
    expect(md.new_supabase_provider_id).toBe(NEW_GOTRUE_ID)
  })

  it('on CAS failure, rolls back the new GoTrue provider via DELETE and returns DB_ERROR', async () => {
    setFromBehavior('sso_providers', {
      selectMaybeSingle: {
        data: existingProviderRow({ entity_id: 'http://prev/entity' }),
        error: null,
      },
      // CAS swap returns no row → race lost.
      updateEqEqMaybeSingle: { data: null, error: null },
    })
    gotrueAdminRequestMock
      .mockResolvedValueOnce({ id: NEW_GOTRUE_ID }) // POST new
      .mockResolvedValueOnce(undefined) // rollback DELETE

    const result = await configureOrgSsoProviderFromXml(
      ORG_ID,
      OKTA_VALID_XML,
      { confirmReplaceEntityId: true },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('DB_ERROR')

    // Rollback DELETE called for the NEW GoTrue id (not the old one —
    // we never touched the old provider since the swap failed).
    expect(gotrueAdminRequestMock).toHaveBeenNthCalledWith(
      2,
      'DELETE',
      `/admin/sso/providers/${NEW_GOTRUE_ID}`,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 7. Feature-flag gates
// ─────────────────────────────────────────────────────────────────────

describe('feature flag — NOT_AVAILABLE responses', () => {
  it('returns NOT_AVAILABLE without calling requireOrgAdmin when flag off', async () => {
    isMetadataUploadEnabledForOrgMock.mockReturnValue(false)

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('NOT_AVAILABLE')
    // Critical: no auth roundtrip. Mini-D11 explicitly requires this.
    expect(requireOrgAdminMock).not.toHaveBeenCalled()
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })

  it('URL action also returns NOT_AVAILABLE without auth roundtrip', async () => {
    isMetadataUploadEnabledForOrgMock.mockReturnValue(false)

    const result = await configureOrgSsoProviderFromUrl(
      ORG_ID,
      'https://idp.example.com/metadata',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('NOT_AVAILABLE')
    expect(requireOrgAdminMock).not.toHaveBeenCalled()
    expect(safeFetchMetadataMock).not.toHaveBeenCalled()
    expect(checkRateLimitMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 8. Auth gate
// ─────────────────────────────────────────────────────────────────────

describe('auth gate — NOT_AUTHORIZED', () => {
  it('returns NOT_AUTHORIZED with auth.error string, no GoTrue or DB calls', async () => {
    requireOrgAdminMock.mockResolvedValueOnce({
      ok: false,
      error: 'Not a member of this organization',
      code: 'not_member',
    })

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('NOT_AUTHORIZED')
    expect(result.error).toBe('Not a member of this organization')
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 9. URL action: rate-limit hit
// ─────────────────────────────────────────────────────────────────────

describe('URL action — rate limit hit', () => {
  it('returns RATE_LIMITED, does NOT call safeFetchMetadata', async () => {
    const resetAt = Date.now() + 30_000
    checkRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt,
      limit: 5,
    })

    const result = await configureOrgSsoProviderFromUrl(
      ORG_ID,
      'https://idp.example.com/metadata',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('RATE_LIMITED')
    expect(result.details?.rate_limit_reset_at).toBe(resetAt)
    expect(safeFetchMetadataMock).not.toHaveBeenCalled()
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 10. Validation forwarding from primitives
// ─────────────────────────────────────────────────────────────────────

describe('validation — forwarded from primitives', () => {
  it('XXE DOCTYPE in XML → DOCTYPE_FORBIDDEN, no GoTrue call', async () => {
    const result = await configureOrgSsoProviderFromXml(ORG_ID, XXE_XML)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('DOCTYPE_FORBIDDEN')
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })

  it('expired cert → CERT_EXPIRED', async () => {
    const result = await configureOrgSsoProviderFromXml(ORG_ID, EXPIRED_XML)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('CERT_EXPIRED')
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })

  it('safeFetch returns PRIVATE_IP → forwarded as PRIVATE_IP', async () => {
    safeFetchMetadataMock.mockResolvedValueOnce({
      ok: false,
      error: 'URL resolves to a private or special-use IP address',
      errorCode: 'PRIVATE_IP',
    })

    const result = await configureOrgSsoProviderFromUrl(
      ORG_ID,
      'https://internal.local/metadata',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('PRIVATE_IP')
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 11. GoTrue / DB failure paths
// ─────────────────────────────────────────────────────────────────────

describe('GoTrue / DB failures', () => {
  it('GoTrue POST fails → GOTRUE_ERROR, no DB write', async () => {
    const err: Error & { status?: number; gotrueCode?: string } = new Error(
      'connection refused',
    )
    err.status = 502
    err.gotrueCode = 'http_502'
    gotrueAdminRequestMock.mockRejectedValueOnce(err)

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('GOTRUE_ERROR')
    // No insert or audit emit on GoTrue failure.
    expect(emitSsoAuditEventMock).not.toHaveBeenCalled()
  })

  it('DB insert fails after GoTrue POST → rollback DELETE called', async () => {
    gotrueAdminRequestMock
      .mockResolvedValueOnce({ id: NEW_GOTRUE_ID }) // POST
      .mockResolvedValueOnce(undefined) // rollback DELETE

    setFromBehavior('sso_providers', {
      selectMaybeSingle: { data: null, error: null },
      insertSingle: {
        data: null,
        error: { message: 'unique constraint violation' },
      },
    })

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('DB_ERROR')

    // The rollback DELETE was called for the new GoTrue id.
    expect(gotrueAdminRequestMock).toHaveBeenNthCalledWith(
      2,
      'DELETE',
      `/admin/sso/providers/${NEW_GOTRUE_ID}`,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// 12. Password-only users guardrail
// ─────────────────────────────────────────────────────────────────────

describe('password-only users guardrail', () => {
  it('returns PASSWORD_USERS_EXIST when count > 0 and forceOverride is not set', async () => {
    supabaseRpcMock.mockResolvedValueOnce({ data: 3, error: null })

    const result = await configureOrgSsoProviderFromXml(ORG_ID, OKTA_VALID_XML)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errorCode).toBe('PASSWORD_USERS_EXIST')
    expect(result.passwordUserCount).toBe(3)
    expect(gotrueAdminRequestMock).not.toHaveBeenCalled()
  })

  it('forceOverride: true bypasses the password-only check', async () => {
    supabaseRpcMock.mockResolvedValueOnce({ data: 3, error: null })
    gotrueAdminRequestMock.mockResolvedValueOnce({ id: NEW_GOTRUE_ID })
    setFromBehavior('sso_providers', {
      selectMaybeSingle: { data: null, error: null },
      insertSingle: {
        data: existingProviderRow({
          supabase_provider_id: NEW_GOTRUE_ID,
          cert_fingerprint_sha256: OKTA_FINGERPRINT,
          entity_id: OKTA_ENTITY_ID,
        }),
        error: null,
      },
    })

    const result = await configureOrgSsoProviderFromXml(
      ORG_ID,
      OKTA_VALID_XML,
      { forceOverride: true },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe('created')
    // RPC was NOT consulted because forceOverride bypassed it.
    expect(supabaseRpcMock).not.toHaveBeenCalled()
  })
})

// Quiet TS unused: a couple of mocks declared at the top but only
// indirectly used through chain factories.
void (gotrueAdminRequestMock as Mock)
void (safeFetchMetadataMock as Mock)
