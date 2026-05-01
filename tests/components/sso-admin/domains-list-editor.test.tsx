import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DomainsList } from '@/app/app/settings/sso/components/DomainsList'

// Mocks must be declared before importing the component module.
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

const addOrgSsoDomainMock = vi.fn()
const removeOrgSsoDomainMock = vi.fn()
vi.mock('@/lib/actions/sso-admin-mutations', () => ({
  addOrgSsoDomain: (...args: unknown[]) => addOrgSsoDomainMock(...args),
  removeOrgSsoDomain: (...args: unknown[]) => removeOrgSsoDomainMock(...args),
  setOrgEnforcementMode: vi.fn(),
  previewEnforcementChange: vi.fn(),
}))

const ORG_ID = '00000000-0000-0000-0000-000000000001'

beforeEach(() => {
  refreshMock.mockClear()
  addOrgSsoDomainMock.mockReset()
  removeOrgSsoDomainMock.mockReset()
})

describe('DomainsList — read-only mode (canEdit=false)', () => {
  it('does NOT render the add-domain form when canEdit is false', () => {
    render(
      <DomainsList
        domains={{ ok: true, domains: [{ id: 'd1', domain: 'acme.com' }] }}
        canEdit={false}
        orgId={ORG_ID}
      />,
    )
    expect(screen.queryByTestId('add-domain-form')).toBeNull()
  })

  it('does NOT render remove buttons on rows when canEdit is false', () => {
    render(
      <DomainsList
        domains={{ ok: true, domains: [{ id: 'd1', domain: 'acme.com' }] }}
        canEdit={false}
        orgId={ORG_ID}
      />,
    )
    expect(screen.queryByTestId('start-remove-domain')).toBeNull()
  })
})

describe('DomainsList — add-domain flow (canEdit=true)', () => {
  it('renders the add-domain form with input and submit button', () => {
    render(
      <DomainsList
        domains={{ ok: true, domains: [] }}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    expect(screen.getByTestId('add-domain-input')).toBeTruthy()
    expect(screen.getByTestId('add-domain-submit')).toBeTruthy()
  })

  it('disables submit when input is empty', () => {
    render(
      <DomainsList
        domains={{ ok: true, domains: [] }}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    const submit = screen.getByTestId('add-domain-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it('calls addOrgSsoDomain with (orgId, input) on submit and refreshes on success', async () => {
    addOrgSsoDomainMock.mockResolvedValueOnce({
      ok: true,
      domain: { id: 'new-1', domain: 'new.example' },
    })
    render(
      <DomainsList
        domains={{ ok: true, domains: [] }}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    const input = screen.getByTestId('add-domain-input') as HTMLInputElement
    const submit = screen.getByTestId('add-domain-submit')

    fireEvent.change(input, { target: { value: 'new.example' } })
    fireEvent.click(submit)

    await waitFor(() => {
      expect(addOrgSsoDomainMock).toHaveBeenCalledWith(ORG_ID, 'new.example')
    })
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
  })

  it('surfaces validation errors inline and does NOT refresh on ok:false', async () => {
    addOrgSsoDomainMock.mockResolvedValueOnce({
      ok: false,
      error: 'Domain format is invalid',
      errorCode: 'VALIDATION',
    })
    render(
      <DomainsList
        domains={{ ok: true, domains: [] }}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    const input = screen.getByTestId('add-domain-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bogus' } })
    fireEvent.click(screen.getByTestId('add-domain-submit'))

    const err = await screen.findByTestId('add-domain-error')
    expect(err.textContent).toMatch(/Domain format is invalid/)
    expect(refreshMock).not.toHaveBeenCalled()
  })
})

describe('DomainsList — remove flow (canEdit=true, multi-domain org)', () => {
  it('opens inline confirm when × is clicked on a non-last domain', () => {
    render(
      <DomainsList
        domains={{
          ok: true,
          domains: [
            { id: 'd1', domain: 'acme.com' },
            { id: 'd2', domain: 'acme.io' },
          ],
        }}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    const removeBtns = screen.getAllByTestId('start-remove-domain')
    fireEvent.click(removeBtns[0])
    // Inline confirm now visible: "Yes" + "Cancel" buttons in scope.
    expect(screen.getByTestId('confirm-remove-domain')).toBeTruthy()
    expect(screen.getByTestId('cancel-remove-domain')).toBeTruthy()
    // The last-domain modal should NOT be mounted on a multi-domain org.
    expect(screen.queryByTestId('remove-last-domain-dialog')).toBeNull()
  })

  it('calls removeOrgSsoDomain on inline confirm and refreshes', async () => {
    removeOrgSsoDomainMock.mockResolvedValueOnce({
      ok: true,
      was_last_domain: false,
    })
    render(
      <DomainsList
        domains={{
          ok: true,
          domains: [
            { id: 'd1', domain: 'acme.com' },
            { id: 'd2', domain: 'acme.io' },
          ],
        }}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    fireEvent.click(screen.getAllByTestId('start-remove-domain')[0])
    fireEvent.click(screen.getByTestId('confirm-remove-domain'))
    await waitFor(() => {
      expect(removeOrgSsoDomainMock).toHaveBeenCalledWith(ORG_ID, 'acme.com')
    })
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
  })

  it('cancels inline confirm without dispatching the action', () => {
    render(
      <DomainsList
        domains={{
          ok: true,
          domains: [
            { id: 'd1', domain: 'acme.com' },
            { id: 'd2', domain: 'acme.io' },
          ],
        }}
        canEdit={true}
        orgId={ORG_ID}
      />,
    )
    fireEvent.click(screen.getAllByTestId('start-remove-domain')[0])
    fireEvent.click(screen.getByTestId('cancel-remove-domain'))
    expect(removeOrgSsoDomainMock).not.toHaveBeenCalled()
    // Confirm UI gone.
    expect(screen.queryByTestId('confirm-remove-domain')).toBeNull()
  })
})

describe('DomainsList — last-domain removal triggers heavy modal', () => {
  it('opens RemoveLastDomainDialog (NOT inline confirm) when only 1 domain exists', () => {
    render(
      <DomainsList
        domains={{
          ok: true,
          domains: [{ id: 'd1', domain: 'acme.com' }],
        }}
        canEdit={true}
        orgId={ORG_ID}
        enforcementMode="hybrid"
      />,
    )
    fireEvent.click(screen.getByTestId('start-remove-domain'))
    expect(screen.getByTestId('remove-last-domain-dialog')).toBeTruthy()
    // Inline-confirm controls must NOT be shown when the modal path
    // is in play — otherwise the operator could click "Yes" without
    // seeing the warning copy.
    expect(screen.queryByTestId('confirm-remove-domain')).toBeNull()
  })
})
