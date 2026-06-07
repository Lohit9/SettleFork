import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from '@/components/app/PageHeader'

// Refinement 2 (Phase 4-polish-1 final-final, 2026-04-26): the page
// header's title-vs-subtitle hierarchy was sharpened so the title
// ("Mapping") reads as visually dominant against the subtitle (the
// project name slot, e.g. "Heritage Core to Nymbus Core Migration").
//
// Locked contract:
//   • Title (<h1>):  text-base font-bold     text-slate-900
//   • Subtitle:      text-sm  font-normal   text-slate-500
//
// The hierarchy is carried by (a) weight (bold vs normal) and
// (b) color (full-contrast slate-900 vs muted slate-500). Size
// delta (base vs sm) is small but adds reinforcement.

describe('PageHeader — Refinement 2 hierarchy contract', () => {
  it('renders the title with font-bold + text-slate-900 + text-base', () => {
    render(<PageHeader projectName="Heritage Migration" title="Mapping" />)
    const titleEl = screen.getByTestId('page-header-title')
    expect(titleEl.tagName).toBe('H1')
    expect(titleEl.textContent).toBe('Mapping')
    const cls = titleEl.className
    expect(cls).toContain('text-base')
    expect(cls).toContain('font-bold')
    expect(cls).toContain('text-slate-900')
  })

  it('renders the subtitle (projectName) with font-normal + text-slate-500 + text-sm', () => {
    render(<PageHeader projectName="Heritage Migration" title="Mapping" />)
    const subtitleEl = screen.getByTestId('page-header-subtitle')
    expect(subtitleEl.textContent).toBe('Heritage Migration')
    const cls = subtitleEl.className
    expect(cls).toContain('text-sm')
    expect(cls).toContain('font-normal')
    expect(cls).toContain('text-slate-500')
  })

  it('regression guard — prior weight (semibold) and prior subtitle palette are gone', () => {
    // The Phase 4-polish-1 baseline had `font-semibold` on the title
    // and `text-xs text-gray-400` on the subtitle. Pin their
    // absence so a partial-revert doesn't silently regress the
    // hierarchy.
    render(<PageHeader projectName="Heritage Migration" title="Mapping" />)
    const titleCls = screen.getByTestId('page-header-title').className
    expect(titleCls).not.toContain('font-semibold')
    expect(titleCls).not.toContain('text-gray-900')

    const subtitleCls = screen.getByTestId('page-header-subtitle').className
    expect(subtitleCls).not.toContain('text-xs')
    expect(subtitleCls).not.toContain('text-gray-400')
  })

  it('omits the subtitle slot entirely when projectName is empty', () => {
    render(<PageHeader projectName="" title="Mapping" />)
    expect(screen.queryByTestId('page-header-subtitle')).toBeNull()
  })
})
