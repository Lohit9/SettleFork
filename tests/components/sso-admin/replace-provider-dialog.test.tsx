import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReplaceProviderDialog } from '@/app/app/settings/sso/components/ReplaceProviderDialog'

const current = {
  idp_type: 'okta',
  entity_id: 'https://old/metadata',
  cert_fingerprint_sha256: 'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa11111111',
  cert_not_after: '2027-01-01T00:00:00.000Z',
}

const proposed = {
  idp_type: 'entra',
  entity_id: 'https://new/metadata',
  cert_fingerprint_sha256: 'bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb22222222',
  cert_not_after: '2028-01-01T00:00:00.000Z',
}

describe('ReplaceProviderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderDialog(
    overrides: Partial<{
      onOpenChange: (o: boolean) => void
      onConfirm: () => Promise<void>
      errorMessage: string | null
    }> = {},
  ) {
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    render(
      <ReplaceProviderDialog
        open
        onOpenChange={overrides.onOpenChange ?? onOpenChange}
        orgSlug="acme"
        current={current}
        proposed={proposed}
        onConfirm={overrides.onConfirm ?? onConfirm}
        errorMessage={overrides.errorMessage ?? null}
      />,
    )
    return { onOpenChange, onConfirm }
  }

  it('disables Replace by default until slug matches', () => {
    renderDialog()
    const confirm = screen.getByTestId('replace-provider-dialog-confirm')
    expect(confirm.hasAttribute('disabled')).toBe(true)
  })

  it('keeps Replace disabled for partial slug', () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('replace-provider-dialog-slug-input'), {
      target: { value: 'ac' },
    })
    expect(screen.getByTestId('replace-provider-dialog-confirm').hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('enables Replace on exact slug match', () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('replace-provider-dialog-slug-input'), {
      target: { value: 'acme' },
    })
    const confirm = screen.getByTestId('replace-provider-dialog-confirm')
    expect(confirm.hasAttribute('disabled')).toBe(false)
    expect(confirm.getAttribute('data-can-confirm')).toBe('true')
  })

  it('trims trailing whitespace before comparing slug', () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('replace-provider-dialog-slug-input'), {
      target: { value: 'acme   ' },
    })
    expect(screen.getByTestId('replace-provider-dialog-confirm').hasAttribute('disabled')).toBe(
      false,
    )
  })

  it('is case-sensitive on slug', () => {
    renderDialog()
    fireEvent.change(screen.getByTestId('replace-provider-dialog-slug-input'), {
      target: { value: 'Acme' },
    })
    expect(screen.getByTestId('replace-provider-dialog-confirm').hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('calls onConfirm once when Replace clicked with valid slug', async () => {
    const { onConfirm } = renderDialog()
    fireEvent.change(screen.getByTestId('replace-provider-dialog-slug-input'), {
      target: { value: 'acme' },
    })
    fireEvent.click(screen.getByTestId('replace-provider-dialog-confirm'))
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('Cancel is always enabled until confirming (then disabled mid-flight)', async () => {
    let release!: () => void
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const slowConfirm = vi.fn().mockImplementation(() => barrier)
    renderDialog({ onConfirm: slowConfirm })
    fireEvent.change(screen.getByTestId('replace-provider-dialog-slug-input'), {
      target: { value: 'acme' },
    })
    const cancel = screen.getByTestId('replace-provider-dialog-cancel')
    expect(cancel.hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByTestId('replace-provider-dialog-confirm'))
    await vi.waitFor(() => expect(cancel.hasAttribute('disabled')).toBe(true))
    release()
    await vi.waitFor(() => expect(cancel.hasAttribute('disabled')).toBe(false))
  })

  it('renders error banner when errorMessage set', () => {
    renderDialog({ errorMessage: 'Something went wrong' })
    expect(screen.getByTestId('replace-provider-dialog-error').textContent).toContain(
      'Something went wrong',
    )
  })

  it('does not propagate close via onOpenChange while confirming', async () => {
    let release!: () => void
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const onOpenChange = vi.fn()
    const onConfirm = vi.fn().mockImplementation(() => barrier)
    renderDialog({ onOpenChange, onConfirm })
    fireEvent.change(screen.getByTestId('replace-provider-dialog-slug-input'), {
      target: { value: 'acme' },
    })
    fireEvent.click(screen.getByTestId('replace-provider-dialog-confirm'))
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled())
    onOpenChange.mockClear()
    const dialogRoot = screen.getByTestId('replace-provider-dialog')
    const backdrop = dialogRoot.previousElementSibling
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop as Element)
    expect(onOpenChange).not.toHaveBeenCalled()
    release()
    await barrier
  })
})
