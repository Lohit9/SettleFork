import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { DQList } from '@/app/app/projects/[projectId]/mapping/redesign/components/DQList'
import type { ProjectDataQualityIssueRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — DQList primitive tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the empty-collapse, severity ordering (critical → warning → info),
// per-severity icon + label color, and category/description rendering.

function dqRow(
  partial: Partial<ProjectDataQualityIssueRow>,
): ProjectDataQualityIssueRow {
  return {
    id: 'dq-1',
    project_id: 'proj-1',
    source_field_id: 'sf-1',
    severity: 'warning',
    category: 'completeness',
    description: 'Missing values',
    example_values: null,
    recommendation: null,
    acknowledged_at: null,
    acknowledged_by: null,
    created_at: '2026-05-01T00:00:00Z',
    experiment_run_id: null,
    ...partial,
  }
}

describe('DQList — empty collapse', () => {
  it('returns null when issues array is empty', () => {
    const { container } = render(<DQList issues={[]} />)
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('drawer-dq-list')).toBeNull()
  })
})

describe('DQList — severity ordering', () => {
  it('sorts critical → warning → info regardless of input order', () => {
    const issues = [
      dqRow({ id: 'i', severity: 'info', category: 'consistency' }),
      dqRow({ id: 'w', severity: 'warning', category: 'completeness' }),
      dqRow({ id: 'c', severity: 'critical', category: 'integrity' }),
    ]
    render(<DQList issues={issues} />)
    const list = screen.getByTestId('drawer-dq-list')
    const ids = within(list)
      .getAllByTestId('drawer-dq-item')
      .map((el) => el.getAttribute('data-dq-id'))
    expect(ids).toEqual(['c', 'w', 'i'])
  })

  it('does not mutate the caller-supplied array (sidecar maps are shared)', () => {
    const issues = [
      dqRow({ id: 'i', severity: 'info' }),
      dqRow({ id: 'c', severity: 'critical' }),
    ]
    const before = issues.map((x) => x.id)
    render(<DQList issues={issues} />)
    expect(issues.map((x) => x.id)).toEqual(before)
  })
})

describe('DQList — per-severity rendering', () => {
  it('renders critical severity label + red color class', () => {
    render(<DQList issues={[dqRow({ severity: 'critical' })]} />)
    const label = screen.getByTestId('drawer-dq-severity-label')
    expect(label.textContent).toBe('Critical')
    expect(label.className).toContain('text-red-700')
  })

  it('renders warning severity label + amber color class', () => {
    render(<DQList issues={[dqRow({ severity: 'warning' })]} />)
    const label = screen.getByTestId('drawer-dq-severity-label')
    expect(label.textContent).toBe('Warning')
    expect(label.className).toContain('text-amber-800')
  })

  it('renders info severity label + blue color class', () => {
    render(<DQList issues={[dqRow({ severity: 'info' })]} />)
    const label = screen.getByTestId('drawer-dq-severity-label')
    expect(label.textContent).toBe('Info')
    expect(label.className).toContain('text-blue-700')
  })

  it('renders category text + description prose', () => {
    render(
      <DQList
        issues={[
          dqRow({
            category: 'completeness',
            description: 'Field is null in 12% of rows.',
          }),
        ]}
      />,
    )
    expect(screen.getByTestId('drawer-dq-category').textContent).toBe(
      'completeness',
    )
    expect(screen.getByTestId('drawer-dq-description').textContent).toBe(
      'Field is null in 12% of rows.',
    )
  })

  it('records severity on the item via data-dq-severity', () => {
    render(<DQList issues={[dqRow({ id: 'x', severity: 'critical' })]} />)
    const item = screen.getByTestId('drawer-dq-item')
    expect(item.getAttribute('data-dq-severity')).toBe('critical')
  })
})
