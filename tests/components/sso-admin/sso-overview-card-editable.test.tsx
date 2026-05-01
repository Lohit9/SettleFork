import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SsoOverviewCard } from '@/app/app/settings/sso/components/SsoOverviewCard'
import type { GetOrgSsoOverviewResult } from '@/lib/actions/sso-admin'

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

const setOrgEnforcementModeMock = vi.fn()
const previewMock = vi.fn()
vi.mock('@/lib/actions/sso-admin-mutations', () => ({
  addOrgSsoDomain: vi.fn(),
  removeOrgSsoDomain: vi.fn(),
  setOrgEnforcementMode: (...args: unknown[]) =>
    setOrgEnforcementModeMock(...args),
  previewEnforcementChange: (...args: unknown[]) => previewMock(...args),
}))

const ORG_ID = '00000000-0000-0000-0000-000000000001'

beforeEach(() => {
  refreshMock.mockClear()
  setOrgEnforcementModeMock.mockReset()
  previewMock.mockReset()
})

function okOverview(
  overrides: Partial<Extract<GetOrgSsoOverviewResult, { ok: true }>> = {},
): GetOrgSsoOverviewResult {
  return {
    ok: true,
    sso_enabled: true,
    enforcement_mode: 'hybrid',
    sso_configured_at: new Date('2026-04-01T00:00:00Z').toISOString(),
    idp_type: 'okta',
    ...overrides,
  }
}

describe('SsoOverviewCard — read-only mode (canEdit=false)', () => {
  it('renders enforcement as a static badge when canEdit is false', () => {
    render(
      <SsoOverviewCard
        overview={okOverview({ enforcement_mode: 'strict' })}
        canEdit={false}
        orgId={ORG_ID}
      />,
    )
    expect(screen.queryByTestId('enforcement-mode-select')).toBeNull()
    expect(screen.getByText(/Strict \(SSO required\)/)).toBeTruthy()
  })
})

describe('SsoOverviewCard — editable mode (canEdit=true)', () => {
  it('renders the enforcement-mode select with the current value', () => {
    render(
      <SsoOverviewCard
        overview={okOverview({ enforcement_mode: 'hybrid' })}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    const sel = screen.getByTestId('enforcement-mode-select') as HTMLSelectElement
    expect(sel.value).toBe('hybrid')
  })

  it('low-risk transition (hybrid → optional) dispatches WITHOUT opening a dialog', async () => {
    setOrgEnforcementModeMock.mockResolvedValueOnce({
      ok: true,
      previous_mode: 'hybrid',
      new_mode: 'optional',
      was_no_op: false,
    })
    render(
      <SsoOverviewCard
        overview={okOverview({ enforcement_mode: 'hybrid' })}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    const sel = screen.getByTestId('enforcement-mode-select')
    fireEvent.change(sel, { target: { value: 'optional' } })
    await waitFor(() => {
      expect(setOrgEnforcementModeMock).toHaveBeenCalledWith(ORG_ID, 'optional')
    })
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
    // No dialog mounted on the low-risk path.
    expect(screen.queryByTestId('enforcement-change-dialog')).toBeNull()
  })

  it('high-risk transition (hybrid → strict) opens the dialog and does NOT dispatch yet', async () => {
    previewMock.mockResolvedValueOnce({
      ok: true,
      total_members: 5,
      users_without_sso: 0,
      is_lockout_risk: false,
    })
    render(
      <SsoOverviewCard
        overview={okOverview({ enforcement_mode: 'hybrid' })}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    fireEvent.change(screen.getByTestId('enforcement-mode-select'), {
      target: { value: 'strict' },
    })
    await waitFor(() => {
      expect(screen.getByTestId('enforcement-change-dialog')).toBeTruthy()
    })
    expect(setOrgEnforcementModeMock).not.toHaveBeenCalled()
  })

  it('medium-risk transition (strict → optional) opens the dialog with medium risk', async () => {
    render(
      <SsoOverviewCard
        overview={okOverview({ enforcement_mode: 'strict' })}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    fireEvent.change(screen.getByTestId('enforcement-mode-select'), {
      target: { value: 'optional' },
    })
    await waitFor(() => {
      const dlg = screen.getByTestId('enforcement-change-dialog')
      expect(dlg.getAttribute('data-risk')).toBe('medium')
    })
    expect(setOrgEnforcementModeMock).not.toHaveBeenCalled()
  })

  it('confirming the dialog calls setOrgEnforcementMode and refreshes', async () => {
    previewMock.mockResolvedValueOnce({
      ok: true,
      total_members: 1,
      users_without_sso: 0,
      is_lockout_risk: false,
    })
    setOrgEnforcementModeMock.mockResolvedValueOnce({
      ok: true,
      previous_mode: 'hybrid',
      new_mode: 'strict',
      was_no_op: false,
    })
    render(
      <SsoOverviewCard
        overview={okOverview({ enforcement_mode: 'hybrid' })}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    fireEvent.change(screen.getByTestId('enforcement-mode-select'), {
      target: { value: 'strict' },
    })
    // Wait for preview to resolve so the confirm button is enabled.
    await waitFor(() => {
      const btn = screen.getByTestId(
        'enforcement-change-dialog-confirm',
      ) as HTMLButtonElement
      expect(btn.disabled).toBe(false)
    })
    fireEvent.click(screen.getByTestId('enforcement-change-dialog-confirm'))
    await waitFor(() => {
      expect(setOrgEnforcementModeMock).toHaveBeenCalledWith(ORG_ID, 'strict')
    })
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
  })

  it('selecting the same mode is a no-op (no dispatch, no dialog)', () => {
    render(
      <SsoOverviewCard
        overview={okOverview({ enforcement_mode: 'hybrid' })}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    fireEvent.change(screen.getByTestId('enforcement-mode-select'), {
      target: { value: 'hybrid' },
    })
    expect(setOrgEnforcementModeMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('enforcement-change-dialog')).toBeNull()
  })
})
