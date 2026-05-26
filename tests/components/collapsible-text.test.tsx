import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CollapsibleText } from '@/components/ui/collapsible-text'

describe('<CollapsibleText>', () => {
  it('renders full text without toggle when text is shorter than threshold', () => {
    const short = 'A short rationale.'
    render(<CollapsibleText text={short} threshold={400} />)
    expect(screen.getByText(short)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /read more/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show less/i })).not.toBeInTheDocument()
  })

  it('renders truncated text with "Read more" toggle when text exceeds threshold', () => {
    const long =
      'The source field maps to the target field based on naming similarity and type compatibility. ' +
      'Both fields are non-nullable strings with email patterns in their sample values. ' +
      'Sampling confirmed all source values conform to the expected format with no nulls. ' +
      'Additional context comes from the data dictionary indicating this is a primary identifier ' +
      'for the customer record across multiple downstream systems. Cross-table contributors examined.'
    expect(long.length).toBeGreaterThan(400)

    render(<CollapsibleText text={long} threshold={400} />)
    const toggle = screen.getByRole('button', { name: /read more/i })
    expect(toggle).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // Full text should NOT be present in collapsed state; truncated form ends with ellipsis.
    expect(screen.queryByText(long)).not.toBeInTheDocument()
    expect(document.body.textContent).toContain('…')
  })

  it('expands on click and collapses on second click', () => {
    const long =
      'Paragraph one establishing the primary mapping rationale with sufficient detail to comfortably exceed the four-hundred-character threshold used by default. ' +
      'Paragraph two adds cross-table contributor analysis: customers, customer_emails, and auth.users were all considered, but only customers is the dominant source. ' +
      'Paragraph three discusses confidence scoring and post-validation checks against the data dictionary.'
    expect(long.length).toBeGreaterThan(400)

    render(<CollapsibleText text={long} threshold={400} />)
    const toggle = screen.getByRole('button', { name: /read more/i })

    // Expand
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show less/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText(long)).toBeInTheDocument()

    // Collapse
    fireEvent.click(screen.getByRole('button', { name: /show less/i }))
    expect(screen.getByRole('button', { name: /read more/i })).toBeInTheDocument()
    expect(screen.queryByText(long)).not.toBeInTheDocument()
    expect(document.body.textContent).toContain('…')
  })

  it('truncates at a word boundary — never mid-word', () => {
    // 50-char threshold: "Engineering" is the last word that fits within 50 chars
    // of the leading run if we keep word boundaries.
    const text =
      'The source field customer_email maps to the target field Customer.Email based on naming similarity.'
    render(<CollapsibleText text={text} threshold={50} />)

    // Truncated text shown in collapsed state must end with "…" and the
    // character immediately before "…" must be the end of a full word —
    // i.e. the next char in the source must be whitespace or end-of-string.
    const truncated = document.querySelector('p')?.textContent ?? ''
    expect(truncated.endsWith('…')).toBe(true)

    const visible = truncated.slice(0, -1) // drop the ellipsis
    // The visible portion appears verbatim as a prefix of the source text…
    expect(text.startsWith(visible)).toBe(true)
    // …and the source character at the boundary is whitespace (or the string ends),
    // proving we cut at a word boundary, not mid-word.
    const nextChar = text.charAt(visible.length)
    expect(nextChar === '' || /\s/.test(nextChar)).toBe(true)
  })

  it('uses custom renderContent when provided', () => {
    const text = 'Short content.'
    render(
      <CollapsibleText
        text={text}
        renderContent={(t) => <pre data-testid="custom-render">{t}</pre>}
      />,
    )
    expect(screen.getByTestId('custom-render')).toBeInTheDocument()
    expect(screen.getByTestId('custom-render').tagName).toBe('PRE')
  })

  it('truncates near the threshold even when text contains paragraph breaks', () => {
    // Regression for the line-anchored-regex bug: a previous /^.*\s/
    // implementation would snap to the first `\n`, cutting a 405-char
    // rationale down to ~32 chars (right after "Required.").
    const text =
      'Field type: Text(50), Required.\n\n' +
      'Each distinct Assy Item is a manufactured assembly that should become one ' +
      'Engineering Item Master record with Inventory Source = Manufactured. The ' +
      'Engineering BOM Masters contains 1,562 rows but only 123 unique parent ' +
      'assemblies — duplicates collapse on distinct extraction. After whitespace ' +
      'trimming, all 123 Assy Items match a corresponding Products.ProductSKU. ' +
      'Additional context here.'
    expect(text.length).toBeGreaterThan(400)

    render(<CollapsibleText text={text} threshold={400} />)

    const truncated = document.querySelector('p')?.textContent ?? ''
    expect(truncated.endsWith('…')).toBe(true)
    // Must be close to the 400-char threshold, not snapped back to the
    // first paragraph break around char ~32.
    expect(truncated.length).toBeGreaterThan(350)
    // And must contain content past the first paragraph break — sanity
    // check that we crossed the `\n\n` instead of stopping at it.
    expect(truncated).toContain('Each distinct Assy Item')
  })

  it('respects a higher threshold for technical content (e.g. SQL)', () => {
    // Build a 500-char SQL-ish string: below 600 threshold, no truncation.
    const sql = 'CASE WHEN field = '.padEnd(500, 'X')
    expect(sql.length).toBe(500)
    render(<CollapsibleText text={sql} threshold={600} />)
    expect(screen.queryByRole('button', { name: /read more/i })).not.toBeInTheDocument()
  })
})
