import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoverageStatusBadge } from '@/components/path-d/CoverageStatusBadge'
import type { CoverageStatus } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// CoverageStatusBadge — Path D primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the 5 enum variants from migration 093:58
// ('covered' | 'partial' | 'gap' | 'optional' | 'out_of_scope') to their
// label + accessible name + data-status attribute. CVA-style background/text
// classes are exercised structurally (data-status); we don't assert on
// Tailwind token strings since those are visual.

describe('CoverageStatusBadge', () => {
  const cases: Array<{ status: CoverageStatus; label: string }> = [
    { status: 'covered', label: 'Covered' },
    { status: 'partial', label: 'Partial' },
    { status: 'gap', label: 'Gap' },
    { status: 'optional', label: 'Optional' },
    { status: 'out_of_scope', label: 'Out of scope' },
  ]

  it.each(cases)(
    'renders the $status variant with label "$label"',
    ({ status, label }) => {
      render(<CoverageStatusBadge status={status} />)
      expect(screen.getByText(label)).toBeInTheDocument()
    },
  )

  it.each(cases)(
    'sets data-status="$status" on the root element',
    ({ status }) => {
      const { container } = render(<CoverageStatusBadge status={status} />)
      expect(container.firstChild).toHaveAttribute('data-status', status)
    },
  )

  it.each(cases)(
    'exposes an accessible aria-label for the $status variant',
    ({ status, label }) => {
      render(<CoverageStatusBadge status={status} />)
      expect(
        screen.getByLabelText(`Coverage status: ${label}`),
      ).toBeInTheDocument()
    },
  )

  it('forwards an extra className without dropping the variant classes', () => {
    const { container } = render(
      <CoverageStatusBadge status='covered' className='ml-2' />,
    )
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain('ml-2')
    // Variant background still applied
    expect(root.className).toContain('bg-emerald-50')
  })
})
