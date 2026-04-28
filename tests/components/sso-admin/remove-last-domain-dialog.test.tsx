import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RemoveLastDomainDialog } from '@/app/app/settings/sso/components/RemoveLastDomainDialog'

describe('RemoveLastDomainDialog — copy varies by enforcement mode', () => {
  it('strict mode shows the heaviest warning (locked-out, no password fallback)', () => {
    render(
      <RemoveLastDomainDialog
        open={true}
        onOpenChange={vi.fn()}
        domain="acme.com"
        enforcementMode="strict"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    const dlg = screen.getByTestId('remove-last-domain-dialog')
    expect(dlg.getAttribute('data-enforcement-mode')).toBe('strict')
    // Title flags strict explicitly.
    expect(dlg.textContent).toMatch(/Remove last SSO domain \(strict enforcement\)/)
    // Body warns about the no-password-fallback path.
    expect(dlg.textContent).toMatch(/SSO will still be required/)
    expect(dlg.textContent).toMatch(/no password fallback/)
  })

  it('hybrid mode shows the lighter copy (members can still sign in with passwords)', () => {
    render(
      <RemoveLastDomainDialog
        open={true}
        onOpenChange={vi.fn()}
        domain="acme.com"
        enforcementMode="hybrid"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    const dlg = screen.getByTestId('remove-last-domain-dialog')
    expect(dlg.getAttribute('data-enforcement-mode')).toBe('hybrid')
    expect(dlg.textContent).toMatch(/Remove last SSO domain/)
    // Crucially, hybrid copy must NOT carry the strict-only "SSO
    // will still be required" line.
    expect(dlg.textContent).not.toMatch(/SSO will still be required/)
  })

  it('confirm button is always red (destructive) regardless of mode', () => {
    render(
      <RemoveLastDomainDialog
        open={true}
        onOpenChange={vi.fn()}
        domain="acme.com"
        enforcementMode="optional"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    const btn = screen.getByTestId('remove-last-domain-dialog-confirm')
    expect(btn.className).toMatch(/bg-red-600/)
  })

  it('clicking confirm invokes onConfirm', async () => {
    const onConfirm = vi.fn(async () => {})
    render(
      <RemoveLastDomainDialog
        open={true}
        onOpenChange={vi.fn()}
        domain="acme.com"
        enforcementMode="hybrid"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByTestId('remove-last-domain-dialog-confirm'))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })
  })

  it('errorMessage prop renders an inline error banner', () => {
    render(
      <RemoveLastDomainDialog
        open={true}
        onOpenChange={vi.fn()}
        domain="acme.com"
        enforcementMode="hybrid"
        onConfirm={vi.fn(async () => {})}
        errorMessage="Server-side rejected"
      />,
    )
    const banner = screen.getByTestId('remove-last-domain-dialog-error')
    expect(banner.textContent).toMatch(/Server-side rejected/)
  })
})
