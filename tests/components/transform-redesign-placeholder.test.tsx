import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TransformRedesignContent from '@/app/app/projects/[projectId]/transform/redesign/TransformContent'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-6 — retired cross-table-apply transparency note.
// ─────────────────────────────────────────────────────────────────────────────
//
// Phase 4a-3 added a `hasCrossTableMappings` prop + a transparency note to the
// redesign Transform placeholder while the cross-table apply RPC branch was
// stubbed. Phase 4a-6 wired the branch (migration 076) and retired the
// note (alongside the legacy Transform tab disabled-button stack and the
// drawer Sources badge).
//
// These negative invariants pin that the prop and note are gone — a
// regression that re-introduces them here surfaces immediately.

describe('TransformRedesignContent — cross-table apply note retired (Phase 4a-6)', () => {
  it('does NOT render a cross-table-apply note in the placeholder', () => {
    render(
      <TransformRedesignContent projectId="p1" projectName="Test Project" />,
    )
    expect(
      screen.queryByTestId('transform-redesign-cross-table-note'),
    ).toBeNull()
    expect(
      screen.queryByText(/cross-table mappings ships in a future release/i),
    ).toBeNull()
  })

  it('placeholder renders without any cross-table prop in the props contract', () => {
    // Type-system invariant: the component no longer accepts
    // `hasCrossTableMappings`. Authoring with the prop is a TS error;
    // this runtime test pins the surface stays clean.
    render(
      <TransformRedesignContent projectId="p1" projectName="Test Project" />,
    )
    expect(screen.getByTestId('transform-redesign-placeholder')).toBeInTheDocument()
  })
})
