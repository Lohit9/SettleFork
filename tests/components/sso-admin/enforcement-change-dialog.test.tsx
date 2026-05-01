import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import {
  EnforcementChangeDialog,
  classifyEnforcementRisk,
} from '@/app/app/settings/sso/components/EnforcementChangeDialog'

// previewEnforcementChange is the only server-action call the dialog
// makes. Stub it so we can drive the high-risk preflight branches.
const previewMock = vi.fn()
vi.mock('@/lib/actions/sso-admin-mutations', () => ({
  addOrgSsoDomain: vi.fn(),
  removeOrgSsoDomain: vi.fn(),
  setOrgEnforcementMode: vi.fn(),
  previewEnforcementChange: (...args: unknown[]) => previewMock(...args),
}))

const ORG_ID = '00000000-0000-0000-0000-000000000001'

beforeEach(() => {
  previewMock.mockReset()
})

// ─── classifyEnforcementRisk — pure function, parametrized ────────────

describe('classifyEnforcementRisk', () => {
  const cases: ReadonlyArray<
    [
      'optional' | 'hybrid' | 'strict',
      'optional' | 'hybrid' | 'strict',
      'low' | 'medium' | 'high',
    ]
  > = [
    // Same-mode → low (no-op)
    ['optional', 'optional', 'low'],
    ['hybrid', 'hybrid', 'low'],
    ['strict', 'strict', 'low'],
    // Optional ↔ hybrid → low (no end-user impact)
    ['optional', 'hybrid', 'low'],
    ['hybrid', 'optional', 'low'],
    // Anything → strict → high (lockout potential)
    ['optional', 'strict', 'high'],
    ['hybrid', 'strict', 'high'],
    // Strict → anything → medium (weakening enforcement)
    ['strict', 'hybrid', 'medium'],
    ['strict', 'optional', 'medium'],
  ]

  it.each(cases)(
    'classifyEnforcementRisk(%s, %s) === %s',
    (from, to, expected) => {
      expect(classifyEnforcementRisk(from, to)).toBe(expected)
    },
  )
})

// ─── Medium-risk modal copy ───────────────────────────────────────────

describe('EnforcementChangeDialog — medium risk (strict → hybrid)', () => {
  it('renders title with "Weaken enforcement"', () => {
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="strict"
        toMode="hybrid"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    const dlg = screen.getByTestId('enforcement-change-dialog')
    expect(dlg.getAttribute('data-risk')).toBe('medium')
    expect(dlg.textContent).toMatch(/Weaken enforcement: strict → hybrid/)
  })

  it('does NOT call previewEnforcementChange for medium-risk transitions', async () => {
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="strict"
        toMode="optional"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    // Allow useEffect microtasks to flush.
    await new Promise((r) => setTimeout(r, 0))
    expect(previewMock).not.toHaveBeenCalled()
  })

  it('confirm button uses amber tone (medium) NOT red (high)', () => {
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="strict"
        toMode="hybrid"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    const btn = screen.getByTestId('enforcement-change-dialog-confirm')
    expect(btn.className).toMatch(/amber/)
    expect(btn.className).not.toMatch(/bg-red-600/)
  })
})

// ─── High-risk modal copy + preflight ─────────────────────────────────

describe('EnforcementChangeDialog — high risk (* → strict)', () => {
  it('calls previewEnforcementChange on open and renders the count', async () => {
    previewMock.mockResolvedValueOnce({
      ok: true,
      total_members: 12,
      users_without_sso: 3,
      is_lockout_risk: true,
    })
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="hybrid"
        toMode="strict"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    await waitFor(() => {
      expect(previewMock).toHaveBeenCalledWith(ORG_ID, 'strict')
    })
    await waitFor(() => {
      expect(screen.getByTestId('enforcement-change-dialog').textContent).toMatch(
        /3 of 12 members do not yet have an SSO identity/,
      )
    })
  })

  it('renders "no one will be locked out" copy when users_without_sso === 0', async () => {
    previewMock.mockResolvedValueOnce({
      ok: true,
      total_members: 12,
      users_without_sso: 0,
      is_lockout_risk: false,
    })
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="hybrid"
        toMode="strict"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('enforcement-change-dialog').textContent).toMatch(
        /All 12 members are SSO-linked/,
      )
    })
  })

  it('falls through to a conservative warning copy when preview fails', async () => {
    previewMock.mockResolvedValueOnce({
      ok: false,
      error: 'Failed to count members',
    })
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="optional"
        toMode="strict"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('enforcement-change-dialog').textContent).toMatch(
        /Preflight check failed/,
      )
    })
    expect(screen.getByTestId('enforcement-change-dialog').textContent).toMatch(
      /MAY lock out members without SSO identities/,
    )
  })

  it('confirm button uses red tone (high) NOT amber', async () => {
    previewMock.mockResolvedValueOnce({
      ok: true,
      total_members: 5,
      users_without_sso: 0,
      is_lockout_risk: false,
    })
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="hybrid"
        toMode="strict"
        onConfirm={vi.fn(async () => {})}
      />,
    )
    const btn = screen.getByTestId('enforcement-change-dialog-confirm')
    expect(btn.className).toMatch(/bg-red-600/)
    expect(btn.className).not.toMatch(/bg-amber-600/)
  })
})

// ─── onConfirm round-trip ─────────────────────────────────────────────

describe('EnforcementChangeDialog — onConfirm flow', () => {
  it('invokes onConfirm when the confirm button is clicked', async () => {
    const onConfirm = vi.fn(async () => {})
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="strict"
        toMode="hybrid"
        onConfirm={onConfirm}
      />,
    )
    fireEvent.click(screen.getByTestId('enforcement-change-dialog-confirm'))
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })
  })

  it('renders an inline error banner when errorMessage prop is set', () => {
    render(
      <EnforcementChangeDialog
        open={true}
        onOpenChange={vi.fn()}
        orgId={ORG_ID}
        fromMode="strict"
        toMode="hybrid"
        onConfirm={vi.fn(async () => {})}
        errorMessage="Something went wrong server-side"
      />,
    )
    const banner = screen.getByTestId('enforcement-change-dialog-error')
    expect(banner.textContent).toMatch(/Something went wrong server-side/)
  })
})
