import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RoleTooltip, ROLE_TOOLTIP_COPY } from '@/components/app/RoleTooltip'

// ─────────────────────────────────────────────────────────────────────────────
// PR 3 — RoleTooltip + ROLE_TOOLTIP_COPY contract pin.
// ─────────────────────────────────────────────────────────────────────────────
//
// The tooltip is a hover-only affordance on disabled controls. Tests verify:
//   - `allowed=true` pass-through (no wrapper, no extra DOM)
//   - `allowed=false` wraps in a positioned tooltip-trigger div
//   - Legacy `requiredRole` slot interpolates into the canonical template
//   - New `tooltipKey` looks up the canonical full string verbatim
//   - `ROLE_TOOLTIP_COPY` exports both `editor` and `admin` keys (drift guard)

describe('RoleTooltip', () => {
  it('renders children unchanged when allowed=true (no wrapper)', () => {
    const { container } = render(
      <RoleTooltip allowed requiredRole="Editor">
        <button data-testid="trigger">Action</button>
      </RoleTooltip>,
    )
    // The wrapper has class `group/role-tip`; absence of that wrapper means
    // the children rendered as-is. <Fragment> doesn't add a DOM node, so the
    // root container's first child should be the <button> itself.
    const trigger = screen.getByTestId('trigger')
    expect(trigger).toBeTruthy()
    expect(container.querySelector('.group\\/role-tip')).toBeNull()
  })

  it('wraps children in a tooltip-trigger when allowed=false', () => {
    const { container } = render(
      <RoleTooltip allowed={false} requiredRole="Editor">
        <button data-testid="trigger">Action</button>
      </RoleTooltip>,
    )
    expect(container.querySelector('.group\\/role-tip')).toBeTruthy()
    expect(screen.getByTestId('trigger')).toBeTruthy()
  })

  it('legacy `requiredRole="Editor"` interpolates into the templated message', () => {
    render(
      <RoleTooltip allowed={false} requiredRole="Editor">
        <button>Action</button>
      </RoleTooltip>,
    )
    expect(
      screen.getByText('You need Editor access to perform this action'),
    ).toBeTruthy()
  })

  it('legacy `requiredRole="Admin"` interpolates into the templated message', () => {
    render(
      <RoleTooltip allowed={false} requiredRole="Admin">
        <button>Action</button>
      </RoleTooltip>,
    )
    expect(
      screen.getByText('You need Admin access to perform this action'),
    ).toBeTruthy()
  })

  it('`tooltipKey="editor"` renders the canonical string from ROLE_TOOLTIP_COPY', () => {
    render(
      <RoleTooltip allowed={false} tooltipKey="editor">
        <button>Action</button>
      </RoleTooltip>,
    )
    expect(screen.getByText(ROLE_TOOLTIP_COPY.editor)).toBeTruthy()
  })

  it('`tooltipKey="admin"` renders the canonical string from ROLE_TOOLTIP_COPY', () => {
    render(
      <RoleTooltip allowed={false} tooltipKey="admin">
        <button>Action</button>
      </RoleTooltip>,
    )
    expect(screen.getByText(ROLE_TOOLTIP_COPY.admin)).toBeTruthy()
  })

  it('tooltipKey takes precedence over requiredRole when both are passed', () => {
    render(
      <RoleTooltip allowed={false} tooltipKey="admin" requiredRole="Editor">
        <button>Action</button>
      </RoleTooltip>,
    )
    expect(screen.getByText(ROLE_TOOLTIP_COPY.admin)).toBeTruthy()
    expect(
      screen.queryByText('You need Editor access to perform this action'),
    ).toBeNull()
  })
})

describe('ROLE_TOOLTIP_COPY', () => {
  it('exports both `editor` and `admin` keys', () => {
    expect(ROLE_TOOLTIP_COPY.editor).toBe(
      'You need Editor access to perform this action',
    )
    expect(ROLE_TOOLTIP_COPY.admin).toBe(
      'You need Admin access to perform this action',
    )
  })

  it('the editor copy matches what the legacy `requiredRole="Editor"` template produces (drift guard)', () => {
    // If we ever change the legacy template, the constant should change in
    // lockstep — this test fails in that case to flag the discrepancy.
    const legacyOutput = `You need Editor access to perform this action`
    expect(ROLE_TOOLTIP_COPY.editor).toBe(legacyOutput)
  })
})
