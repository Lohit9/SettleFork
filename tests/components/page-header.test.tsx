import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from '@/components/app/PageHeader'

// The page header's title-vs-subtitle hierarchy, repinned to the
// Configure-design restyle (feat(mapping): design-align spec table &
// page header). The title ("Mapping" / "Configure" / …) is the
// dominant element; the subtitle slot carries the project name
// (e.g. "Heritage Core to Nymbus Core Migration").
//
// Locked contract (matches components/app/PageHeader.tsx):
//   • Title (<h1>):  text-[15px]   font-semibold  text-[#111827]
//   • Subtitle:      text-[13.5px] font-normal     text-[#6B7280]
//
// The hierarchy is carried by weight (semibold vs normal), size
// (15px vs 13.5px), and color contrast (#111827 vs #6B7280).

describe('PageHeader — Configure-restyle hierarchy contract', () => {
  it('renders the title with font-semibold + text-[#111827] + text-[15px]', () => {
    render(<PageHeader projectName="Heritage Migration" title="Mapping" />)
    const titleEl = screen.getByTestId('page-header-title')
    expect(titleEl.tagName).toBe('H1')
    expect(titleEl.textContent).toBe('Mapping')
    const cls = titleEl.className
    expect(cls).toContain('text-[15px]')
    expect(cls).toContain('font-semibold')
    expect(cls).toContain('text-[#111827]')
  })

  it('renders the subtitle (projectName) with font-normal + text-[#6B7280] + text-[13.5px]', () => {
    render(<PageHeader projectName="Heritage Migration" title="Mapping" />)
    const subtitleEl = screen.getByTestId('page-header-subtitle')
    expect(subtitleEl.textContent).toBe('Heritage Migration')
    const cls = subtitleEl.className
    expect(cls).toContain('text-[13.5px]')
    expect(cls).toContain('font-normal')
    expect(cls).toContain('text-[#6B7280]')
  })

  it('regression guard — the prior slate/gray palette is gone', () => {
    // The restyle moved off the immediately-prior slate palette
    // (text-slate-900 title, text-sm / text-slate-500 subtitle) and the
    // older gray palette before it (text-xs / text-gray-400) to explicit
    // hex. Pin those palettes' absence so a partial revert doesn't
    // silently regress the hierarchy. Weight is no longer guarded here —
    // the title now uses font-semibold, asserted positively above.
    render(<PageHeader projectName="Heritage Migration" title="Mapping" />)
    const titleCls = screen.getByTestId('page-header-title').className
    expect(titleCls).not.toContain('text-slate-900')
    expect(titleCls).not.toContain('text-gray-900')

    const subtitleCls = screen.getByTestId('page-header-subtitle').className
    expect(subtitleCls).not.toContain('text-sm')
    expect(subtitleCls).not.toContain('text-slate-500')
    expect(subtitleCls).not.toContain('text-xs')
    expect(subtitleCls).not.toContain('text-gray-400')
  })

  it('omits the subtitle slot entirely when projectName is empty', () => {
    render(<PageHeader projectName="" title="Mapping" />)
    expect(screen.queryByTestId('page-header-subtitle')).toBeNull()
  })
})
