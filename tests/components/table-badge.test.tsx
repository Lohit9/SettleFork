import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TableBadge } from '@/app/app/projects/[projectId]/mapping/redesign/components/TableBadge'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 4c — TableBadge primitive tests.
// ─────────────────────────────────────────────────────────────────────────────

describe('TableBadge', () => {
  it('renders the table name', () => {
    render(<TableBadge tableName="ACCT_MASTER" />)
    expect(screen.getByText('ACCT_MASTER')).toBeInTheDocument()
  })

  it('renders the dataset subtitle when provided', () => {
    render(<TableBadge tableName="customers" datasetName="Heritage Core" />)
    expect(screen.getByText('customers')).toBeInTheDocument()
    expect(screen.getByText('Heritage Core')).toBeInTheDocument()
  })

  it('omits the dataset subtitle when absent', () => {
    const { container } = render(<TableBadge tableName="accounts" />)
    // Only one text node should exist — the table name. No subtitle div.
    const textNodes = container.querySelectorAll('span > span')
    expect(textNodes.length).toBe(1)
    expect(textNodes[0]?.textContent).toBe('accounts')
  })

  it('applies truncation class on the name span', () => {
    const { container } = render(<TableBadge tableName="very_long_table_name_here" />)
    const nameSpan = container.querySelector('span.font-mono')
    expect(nameSpan).toBeTruthy()
    expect(nameSpan?.className).toContain('truncate')
  })

  it('applies truncation on the dataset subtitle too', () => {
    const { container } = render(
      <TableBadge tableName="orders" datasetName="a_really_long_dataset_name" />,
    )
    const subtitleSpan = container.querySelectorAll('span > span')[1]
    expect(subtitleSpan?.className).toContain('truncate')
  })

  it('composes user-provided className', () => {
    const { container } = render(
      <TableBadge tableName="orders" className="custom-test-class" />,
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain('custom-test-class')
  })

  it('sets a title attribute combining name and dataset', () => {
    const { container } = render(
      <TableBadge tableName="orders" datasetName="Heritage Core" />,
    )
    const wrapper = container.firstElementChild
    expect(wrapper?.getAttribute('title')).toBe('orders · Heritage Core')
  })

  it('sets a title attribute with just the name when no dataset', () => {
    const { container } = render(<TableBadge tableName="orders" />)
    const wrapper = container.firstElementChild
    expect(wrapper?.getAttribute('title')).toBe('orders')
  })

  // ─── Gap 5a hotfix 2026-04-23 ─── no dark-prefix Tailwind modifiers ────────
  //
  // The surrounding redesign UI hardcodes a light background (bg-white on
  // TargetTableGroup, bg-gray-50 on the page). Tailwind's `darkMode: 'media'`
  // default would fire any dark-prefix text variant automatically in OS dark
  // mode, producing near-white-on-white ghosted text (the 2026-04-23 bug).
  //
  // Companion invariant: tests/lib/no-shim-in-redesign-path.test.ts greps
  // every redesign source file for the dark-prefix token at CI time. These
  // className assertions are the component-level smoke-test safety net.
  describe('light-mode-only invariant', () => {
    it('name span uses light-mode text color and no dark-prefix', () => {
      const { container } = render(<TableBadge tableName="accounts" />)
      const wrapper = container.firstElementChild
      expect(wrapper?.className).toContain('text-slate-700')
      expect(wrapper?.className).not.toMatch(/\bdark:/)
    })

    it('dataset subtitle uses light-mode text color and no dark-prefix', () => {
      const { container } = render(
        <TableBadge tableName="accounts" datasetName="Heritage Core" />,
      )
      const subtitleSpan = container.querySelectorAll('span > span')[1]
      expect(subtitleSpan?.className).toContain('text-slate-500')
      expect(subtitleSpan?.className).not.toMatch(/\bdark:/)
    })
  })
})
