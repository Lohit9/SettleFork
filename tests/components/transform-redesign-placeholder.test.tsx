import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TransformRedesignContent from '@/app/app/projects/[projectId]/transform/redesign/TransformContent'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-3 — Transform redesign placeholder cross-table note.
// ─────────────────────────────────────────────────────────────────────────────
//
// The redesign Transform UI is still a Phase-3 placeholder. Block F Part B
// (Apply/Test button disabling) only fires on the legacy Transform UI, so
// flag-on projects with cross-table mappings would otherwise see no UI-side
// transparency that cross-table apply isn't yet supported. The placeholder
// renders an additional informational note when `hasCrossTableMappings` is
// true. These tests pin that contract.

describe('TransformRedesignContent — cross-table apply note', () => {
  it('renders the cross-table-apply note when hasCrossTableMappings is true', () => {
    render(
      <TransformRedesignContent
        projectId="p1"
        projectName="Test Project"
        hasCrossTableMappings={true}
      />,
    )
    const note = screen.getByTestId('transform-redesign-cross-table-note')
    expect(note).toBeInTheDocument()
    expect(note.textContent).toMatch(/cross-table mappings/i)
    expect(note.textContent).toMatch(
      /Transform application for cross-table mappings ships in a future release/i,
    )
  })

  it('does NOT render the note when hasCrossTableMappings is false', () => {
    render(
      <TransformRedesignContent
        projectId="p1"
        projectName="Test Project"
        hasCrossTableMappings={false}
      />,
    )
    expect(
      screen.queryByTestId('transform-redesign-cross-table-note'),
    ).toBeNull()
  })

  it('does NOT render the note when hasCrossTableMappings prop is omitted (default false)', () => {
    render(
      <TransformRedesignContent projectId="p1" projectName="Test Project" />,
    )
    expect(
      screen.queryByTestId('transform-redesign-cross-table-note'),
    ).toBeNull()
  })

  it('renders the note BELOW the project ID/name dl block (visual ordering)', () => {
    const { container } = render(
      <TransformRedesignContent
        projectId="p1"
        projectName="Test Project"
        hasCrossTableMappings={true}
      />,
    )
    const placeholder = screen.getByTestId('transform-redesign-placeholder')
    const dl = placeholder.querySelector('dl')
    const note = screen.getByTestId('transform-redesign-cross-table-note')
    // dl precedes the note in document order
    expect(dl).not.toBeNull()
    const allChildren = Array.from(placeholder.children)
    const dlIdx = allChildren.indexOf(dl as Element)
    const noteIdx = allChildren.indexOf(note)
    expect(dlIdx).toBeGreaterThanOrEqual(0)
    expect(noteIdx).toBeGreaterThan(dlIdx)
    // Smaller-text + slate-600 visual treatment
    expect(note.className).toContain('text-xs')
    expect(note.className).toContain('text-slate-600')
    expect(container.innerHTML).not.toMatch(/\bdark:/)
  })
})
