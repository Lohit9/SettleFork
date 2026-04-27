import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExpandedSourceList } from '@/app/app/projects/[projectId]/mapping/redesign/components/ExpandedSourceList'
import type { MappingSourceRef } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 5b — ExpandedSourceList tests.
// ─────────────────────────────────────────────────────────────────────────────

function source(
  overrides: Partial<MappingSourceRef> & { tableName?: string; fieldName?: string } = {},
): MappingSourceRef {
  const { tableName = 'CIF_MASTER', fieldName = 'FNAME', ...rest } = overrides
  return {
    id: `ms-${fieldName}`,
    ordinal: 0,
    confidence: 92,
    aiReasoning: null,
    typeCompatibility: null,
    sourceField: { id: `sf-${fieldName}`, name: fieldName, dataType: 'VARCHAR', isNullable: false },
    sourceTable: { id: `st-${tableName}`, name: tableName },
    joinAnnotation: null,
    joinSpec: null,
    sampleValues: [],
    ...rest,
  }
}

describe('ExpandedSourceList', () => {
  it('renders one bullet line per source', () => {
    const sources = [
      source({ fieldName: 'FNAME' }),
      source({ fieldName: 'LNAME' }),
      source({ fieldName: 'MI' }),
    ]
    render(<ExpandedSourceList sources={sources} rule="rule_2" />)
    const bullets = screen.getAllByTestId('expanded-source-bullet')
    expect(bullets).toHaveLength(3)
  })

  it('renders the source field name inside each bullet', () => {
    const sources = [
      source({ fieldName: 'FNAME' }),
      source({ fieldName: 'LNAME' }),
    ]
    render(<ExpandedSourceList sources={sources} rule="rule_2" />)
    expect(screen.getByText('FNAME')).toBeInTheDocument()
    expect(screen.getByText('LNAME')).toBeInTheDocument()
  })

  it('renders a TableBadge per source', () => {
    const sources = [
      source({ tableName: 'TABLE_A', fieldName: 'A1' }),
      source({ tableName: 'TABLE_B', fieldName: 'B1' }),
    ]
    render(<ExpandedSourceList sources={sources} rule="rule_3" />)
    expect(screen.getByText('TABLE_A')).toBeInTheDocument()
    expect(screen.getByText('TABLE_B')).toBeInTheDocument()
  })

  it('renders per-source confidence as integer percent (Refinement H)', () => {
    // Phase 4-polish-1 Refinement H (2026-04-26): confidence renders
    // as integer percent (no decimals) across all consumers of
    // `formatConfidencePercent`. 87.5 rounds to 88.
    const sources = [source({ confidence: 87.5 })]
    render(<ExpandedSourceList sources={sources} rule="rule_2" />)
    expect(screen.getByTestId('expanded-source-confidence').textContent).toBe('88%')
  })

  it('renders joinAnnotation as italic text when present', () => {
    const sources = [
      source({
        tableName: 'CIF_MASTER',
        fieldName: 'FNAME',
        // Canonical contract: `joinAnnotation` arrives pre-wrapped from
        // `deriveJoinAnnotation`. Renderers consume as-is.
        joinAnnotation: '(join: PrimaryContactID)',
      }),
    ]
    render(<ExpandedSourceList sources={sources} rule="rule_3" />)
    const joinNode = screen.getByTestId('expanded-source-join')
    expect(joinNode.textContent).toBe('(join: PrimaryContactID)')
    expect(joinNode.className).toContain('italic')
  })

  // Regression test (Phase 4a-3 smoke): the canonical pre-wrapped
  // `joinAnnotation` produced by `deriveJoinAnnotation` must NOT be
  // wrapped again by the renderer. Earlier the expanded list emitted
  // `(join: (join: FK))`. Guard against re-introduction.
  it('does NOT double-wrap the canonical "(join: …)" annotation', () => {
    const sources = [
      source({
        tableName: 'CONTACTS',
        fieldName: 'EMAIL',
        joinAnnotation: '(join: CIF_NO)',
      }),
    ]
    render(<ExpandedSourceList sources={sources} rule="rule_3" />)
    const joinNode = screen.getByTestId('expanded-source-join')
    expect(joinNode.textContent).toBe('(join: CIF_NO)')
    expect(joinNode.textContent).not.toMatch(/\(join:\s*\(join:/)
  })

  it('does NOT render a join annotation node when joinAnnotation is null (Rule 2 same-table case)', () => {
    const sources = [
      source({ tableName: 'CIF_MASTER', fieldName: 'FNAME', joinAnnotation: null }),
      source({ tableName: 'CIF_MASTER', fieldName: 'LNAME', joinAnnotation: null }),
    ]
    render(<ExpandedSourceList sources={sources} rule="rule_2" />)
    expect(screen.queryAllByTestId('expanded-source-join')).toHaveLength(0)
  })

  it('renders an em-dash for confidence when a source has null confidence', () => {
    const sources = [source({ confidence: null })]
    render(<ExpandedSourceList sources={sources} rule="rule_2" />)
    expect(screen.getByTestId('expanded-source-confidence').textContent).toBe('—')
  })

  it('exposes role="list" and an accessible name for screen readers', () => {
    render(<ExpandedSourceList sources={[source()]} rule="rule_2" />)
    expect(screen.getByRole('list', { name: 'Source fields' })).toBeInTheDocument()
  })

  it('forwards the id prop so a parent chevron can wire aria-controls', () => {
    const { container } = render(
      <ExpandedSourceList sources={[source()]} rule="rule_2" id="expanded-row-42" />,
    )
    expect(container.querySelector('#expanded-row-42')).not.toBeNull()
  })

  // ─── Light-mode-only invariant ───────────────────────────────────────────
  describe('light-mode-only invariant', () => {
    it('entire rendered tree contains no dark-prefix substring', () => {
      const sources = [
        source({ tableName: 'A', fieldName: 'a1', joinAnnotation: '(join: FK)' }),
        source({ tableName: 'B', fieldName: 'b1', joinAnnotation: null }),
      ]
      const { container } = render(<ExpandedSourceList sources={sources} rule="rule_3" />)
      expect(container.innerHTML).not.toMatch(/\bdark:/)
    })

    it('bullet row uses light-mode slate-900 + font-normal for field name (Refinement 6)', () => {
      // Refinement 6 (Phase 4-polish-1 final-final, 2026-04-26): the
      // expanded-source bullet's field-name span tracks the row-level
      // source-field cells — same `font-mono font-normal text-slate-
      // 900`. Hierarchy is column position + header strip, not
      // typography weight/color.
      render(<ExpandedSourceList sources={[source({ fieldName: 'FNAME' })]} rule="rule_2" />)
      const fieldNode = screen.getByText('FNAME')
      expect(fieldNode.className).toContain('text-slate-900')
      expect(fieldNode.className).toContain('font-normal')
      expect(fieldNode.className).not.toContain('text-slate-700')
      expect(fieldNode.className).not.toMatch(/\bdark:/)
    })
  })
})
