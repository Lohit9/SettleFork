import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MetadataUploadCard } from '@/app/app/settings/sso/components/MetadataUploadCard'

const refreshMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: refreshMock,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

const configureXmlMock = vi.fn()
const configureUrlMock = vi.fn()

vi.mock('@/lib/actions/sso-admin-provider-config', () => ({
  configureOrgSsoProviderFromXml: (...args: unknown[]) => configureXmlMock(...args),
  configureOrgSsoProviderFromUrl: (...args: unknown[]) => configureUrlMock(...args),
}))

const currentProvider = {
  idpType: 'okta' as const,
  entityId: 'https://old/metadata',
  certFingerprintSha256:
    'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111',
  certNotAfter: '2027-01-01T00:00:00.000Z',
}

describe('MetadataUploadCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configureXmlMock.mockReset()
    configureUrlMock.mockReset()
    configureXmlMock.mockResolvedValue({ ok: true, action: 'no_op' })
    configureUrlMock.mockResolvedValue({ ok: true, action: 'no_op' })
  })

  function renderCard(overrides: {
    currentProvider?: typeof currentProvider | null
  } = {}) {
    render(
      <MetadataUploadCard
        orgId="org-1"
        orgSlug="acme"
        currentProvider={overrides.currentProvider ?? currentProvider}
      />,
    )
  }

  it('renders XML and URL tab buttons and switches panels', () => {
    renderCard()
    const xmlTab = screen.getByTestId('metadata-upload-tab-xml')
    const urlTab = screen.getByTestId('metadata-upload-tab-url')
    expect(xmlTab.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(urlTab)
    expect(urlTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('metadata-upload-url-input')).toBeTruthy()
    fireEvent.click(xmlTab)
    expect(screen.getByTestId('metadata-upload-drop-zone')).toBeTruthy()
  })

  it('mounts hidden file input with accept including xml', () => {
    renderCard()
    const input = screen.getByTestId('metadata-upload-file-input')
    expect(input.classList.contains('hidden')).toBe(true)
    expect((input as HTMLInputElement).accept).toContain('xml')
  })

  it('adds drag-over highlighting on dragenter/dragover', () => {
    renderCard()
    const zone = screen.getByTestId('metadata-upload-drop-zone')
    fireEvent.dragEnter(zone)
    fireEvent.dragOver(zone)
    expect(zone.className).toContain('border-blue-500')
    fireEvent.dragLeave(zone)
    expect(zone.className).not.toContain('border-blue-500')
  })

  it('reads file and calls configureOrgSsoProviderFromXml', async () => {
    configureXmlMock.mockResolvedValueOnce({ ok: true, action: 'created' })
    renderCard()
    const xml = '<EntityDescriptor />'
    const file = new File([xml], 'meta.xml', { type: 'application/xml' })
    const input = screen.getByTestId('metadata-upload-file-input')
    fireEvent.change(input, { target: { files: [file] } })
    await vi.waitFor(() =>
      expect(configureXmlMock).toHaveBeenCalledWith('org-1', xml),
    )
  })

  it('submits trimmed URL via configureOrgSsoProviderFromUrl', async () => {
    configureUrlMock.mockResolvedValueOnce({ ok: true, action: 'created' })
    renderCard()
    fireEvent.click(screen.getByTestId('metadata-upload-tab-url'))
    fireEvent.change(screen.getByTestId('metadata-upload-url-input'), {
      target: { value: '  https://idp/meta  ' },
    })
    fireEvent.click(screen.getByTestId('metadata-upload-fetch-button'))
    await vi.waitFor(() =>
      expect(configureUrlMock).toHaveBeenCalledWith(
        'org-1',
        'https://idp/meta',
      ),
    )
  })

  it('calls router.refresh on success', async () => {
    configureXmlMock.mockResolvedValueOnce({ ok: true, action: 'created' })
    renderCard({ currentProvider: null })
    const file = new File(['<xml/>'], 'm.xml', { type: 'application/xml' })
    fireEvent.change(screen.getByTestId('metadata-upload-file-input'), {
      target: { files: [file] },
    })
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalled())
  })

  it('opens ReplaceProviderDialog on ENTITY_ID_CHANGED', async () => {
    const proposedFp =
      'bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb22222222'
    configureXmlMock.mockResolvedValueOnce({
      ok: false,
      error: 'Different entity id',
      errorCode: 'ENTITY_ID_CHANGED',
      details: {
        conflicting_entity_id: 'https://new',
        expected_entity_id: currentProvider.entityId,
        proposed_idp_type: 'entra',
        proposed_cert_fingerprint_sha256: proposedFp,
        proposed_cert_not_after: '2028-01-01T00:00:00.000Z',
      },
    })
    renderCard()
    const file = new File(['<xml/>'], 'm.xml', { type: 'application/xml' })
    fireEvent.change(screen.getByTestId('metadata-upload-file-input'), {
      target: { files: [file] },
    })
    await vi.waitFor(() =>
      expect(screen.getByTestId('replace-provider-dialog')).toBeTruthy(),
    )
  })

  it('closes replace dialog on cancel resets pending state', async () => {
    const proposedFp =
      'bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb22222222'
    configureXmlMock.mockResolvedValueOnce({
      ok: false,
      error: 'Different entity id',
      errorCode: 'ENTITY_ID_CHANGED',
      details: {
        conflicting_entity_id: 'https://new',
        expected_entity_id: currentProvider.entityId,
        proposed_idp_type: 'entra',
        proposed_cert_fingerprint_sha256: proposedFp,
        proposed_cert_not_after: '2028-01-01T00:00:00.000Z',
      },
    })
    renderCard()
    const file = new File(['<xml/>'], 'm.xml', { type: 'application/xml' })
    fireEvent.change(screen.getByTestId('metadata-upload-file-input'), {
      target: { files: [file] },
    })
    await vi.waitFor(() =>
      screen.getByTestId('replace-provider-dialog'),
    )
    fireEvent.click(screen.getByTestId('replace-provider-dialog-cancel'))
    await vi.waitFor(() =>
      expect(screen.queryByTestId('replace-provider-dialog')).toBeNull(),
    )
  })

  it('shows static rate-limit countdown suffix', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-01T12:00:00.000Z') })
    configureXmlMock.mockResolvedValueOnce({
      ok: false,
      error: 'Too many requests',
      errorCode: 'RATE_LIMITED',
      details: { rate_limit_reset_at: Date.now() + 5000 },
    })
    renderCard({ currentProvider: null })
    const file = new File(['<xml/>'], 'm.xml', { type: 'application/xml' })
    fireEvent.change(screen.getByTestId('metadata-upload-file-input'), {
      target: { files: [file] },
    })
    await vi.waitFor(() =>
      expect(screen.getByTestId('metadata-upload-error').textContent).toContain(
        'retry in 5s',
      ),
    )
    vi.useRealTimers()
  })

  it('PASSWORD_USERS_EXIST hints contact support', async () => {
    configureXmlMock.mockResolvedValueOnce({
      ok: false,
      error: 'Password accounts exist.',
      errorCode: 'PASSWORD_USERS_EXIST',
    })
    renderCard({ currentProvider: null })
    const file = new File(['<xml/>'], 'm.xml', { type: 'application/xml' })
    fireEvent.change(screen.getByTestId('metadata-upload-file-input'), {
      target: { files: [file] },
    })
    await vi.waitFor(() =>
      expect(screen.getByTestId('metadata-upload-error').textContent).toContain(
        'Contact support to override',
      ),
    )
  })

  it('shows inline alert on generic errors', async () => {
    configureXmlMock.mockResolvedValueOnce({
      ok: false,
      error: 'Bad XML',
      errorCode: 'INVALID_XML',
    })
    renderCard({ currentProvider: null })
    const file = new File(['oops'], 'm.xml', { type: 'application/xml' })
    fireEvent.change(screen.getByTestId('metadata-upload-file-input'), {
      target: { files: [file] },
    })
    const err = await vi.waitFor(() => screen.getByTestId('metadata-upload-error'))
    expect(err.getAttribute('role')).toBe('alert')
    expect(err.textContent).toContain('Bad XML')
  })

  it('rejects >5MB file without calling action', async () => {
    renderCard({ currentProvider: null })
    const big = new Uint8Array(5_000_001).fill(32)
    const file = new File([big], 'huge.xml', { type: 'application/xml' })
    fireEvent.change(screen.getByTestId('metadata-upload-file-input'), {
      target: { files: [file] },
    })
    await vi.waitFor(() =>
      expect(screen.getByTestId('metadata-upload-error').textContent).toContain(
        'too large',
      ),
    )
    expect(configureXmlMock).not.toHaveBeenCalled()
  })
})
