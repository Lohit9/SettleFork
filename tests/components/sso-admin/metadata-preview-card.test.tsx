import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MetadataPreviewCard } from '@/app/app/settings/sso/components/MetadataPreviewCard'

const baseProps = {
  idpType: 'okta' as const,
  entityId: 'https://idp.example.com/metadata',
  certFingerprintSha256:
    'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111',
  certSubject: 'CN=ACME IdP',
  certNotBefore: '2025-01-01T00:00:00.000Z',
  certNotAfter: '2028-01-01T00:00:00.000Z',
  certSignatureAlgorithm: 'sha256RSA',
}

describe('MetadataPreviewCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-06-01T12:00:00.000Z') })
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders detail rows when fields are populated', () => {
    render(<MetadataPreviewCard {...baseProps} />)
    expect(screen.getByTestId('metadata-preview-card')).toBeTruthy()
    expect(screen.getByText('Okta')).toBeTruthy()
    expect(screen.getByText(baseProps.entityId)).toBeTruthy()
    expect(screen.getByText(baseProps.certSubject)).toBeTruthy()
    expect(screen.getByText(baseProps.certFingerprintSha256)).toBeTruthy()
    expect(screen.getByText(baseProps.certSignatureAlgorithm)).toBeTruthy()
  })

  it('renders Entity ID em dash when entityId is null', () => {
    render(<MetadataPreviewCard {...baseProps} entityId={null} />)
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('hides certificate subject row when certSubject is null', () => {
    render(<MetadataPreviewCard {...baseProps} certSubject={null} />)
    expect(screen.queryByText(baseProps.certSubject)).toBeNull()
  })

  it('copies fingerprint via clipboard', async () => {
    render(<MetadataPreviewCard {...baseProps} />)
    const btn = screen.getByTestId('metadata-preview-copy-certificate-fingerprint')
    fireEvent.click(btn)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      baseProps.certFingerprintSha256,
    )
  })

  it('shows expired banner (role=alert) when cert is past expiry', () => {
    render(
      <MetadataPreviewCard {...baseProps} certNotAfter="2026-05-20T00:00:00.000Z" />,
    )
    const banner = screen.getByTestId('metadata-preview-expiry-expired')
    expect(banner).toBeTruthy()
    expect(banner.getAttribute('role')).toBe('alert')
  })

  it('shows critical banner (role=alert) when within 7 days', () => {
    render(
      <MetadataPreviewCard {...baseProps} certNotAfter="2026-06-05T12:00:00.000Z" />,
    )
    const banner = screen.getByTestId('metadata-preview-expiry-critical')
    expect(banner).toBeTruthy()
    expect(banner.getAttribute('role')).toBe('alert')
  })

  it('shows warning banner when within 8–30 days', () => {
    render(
      <MetadataPreviewCard {...baseProps} certNotAfter="2026-06-20T12:00:00.000Z" />,
    )
    expect(screen.getByTestId('metadata-preview-expiry-warning')).toBeTruthy()
  })

  it('shows notice banner when within 31–90 days', () => {
    render(
      <MetadataPreviewCard {...baseProps} certNotAfter="2026-07-25T12:00:00.000Z" />,
    )
    expect(screen.getByTestId('metadata-preview-expiry-notice')).toBeTruthy()
  })

  it('shows no banner when more than 90 days remain', () => {
    render(
      <MetadataPreviewCard {...baseProps} certNotAfter="2026-12-01T12:00:00.000Z" />,
    )
    expect(screen.queryByTestId('metadata-preview-expiry-expired')).toBeNull()
    expect(screen.queryByTestId('metadata-preview-expiry-critical')).toBeNull()
    expect(screen.queryByTestId('metadata-preview-expiry-warning')).toBeNull()
    expect(screen.queryByTestId('metadata-preview-expiry-notice')).toBeNull()
  })
})
