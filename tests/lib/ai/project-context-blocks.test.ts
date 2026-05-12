// @vitest-environment node
//
// Unit tests for the three project-scoped context-block formatters.
// Pins:
//   - Empty inputs → ''  (so callers can unconditionally concatenate)
//   - Populated inputs → expected XML shape with all rows present
//   - Heterogeneous lookup_table.mappings (string OR object) → both pass through
//   - Optional fields omitted when null / empty
//   - XML-special characters escaped in titles / names / descriptions

import { describe, it, expect } from 'vitest'
import {
  formatLookupTablesBlock,
  formatProjectDecisionsBlock,
  formatTransformationIntentBlock,
  type ProjectDecisionRow,
  type ProjectLookupTableRow,
} from '@/lib/ai/project-context-blocks'

// ─── formatLookupTablesBlock ──────────────────────────────────────────────────

describe('formatLookupTablesBlock', () => {
  it('returns empty string for empty input', () => {
    expect(formatLookupTablesBlock([])).toBe('')
  })

  it('returns empty string when given null-ish array', () => {
    expect(formatLookupTablesBlock(undefined as unknown as ProjectLookupTableRow[])).toBe('')
  })

  it('emits one <lookup_table> per row with object-form mappings', () => {
    const tables: ProjectLookupTableRow[] = [
      {
        id: 'lt-1',
        name: 'uom_normalization',
        description: 'Maps source UOMs to Rootstock External Ids',
        mappings: { Each: 'EA', Lbs: 'LB' },
        applies_to_fields: null,
        data_quality_notes: null,
        customer_approved: false,
      },
    ]
    const out = formatLookupTablesBlock(tables)
    expect(out).toContain('<lookup_tables>')
    expect(out).toContain('<lookup_table id="lt-1" name="uom_normalization" customer_approved="false">')
    expect(out).toContain('<description>Maps source UOMs to Rootstock External Ids</description>')
    expect(out).toContain('"Each": "EA"')
    expect(out).toContain('"Lbs": "LB"')
    expect(out).toContain('</lookup_table>')
    expect(out).toContain('</lookup_tables>')
  })

  it('emits string-form mappings verbatim (free-form rule)', () => {
    const tables: ProjectLookupTableRow[] = [
      {
        id: 'lt-2',
        name: 'icc_dominant_uom',
        description: 'Per-ProductGroup dominant UOM',
        mappings: 'Compute at transform time: SELECT DISTINCT ON ...',
        applies_to_fields: null,
        data_quality_notes: null,
        customer_approved: false,
      },
    ]
    const out = formatLookupTablesBlock(tables)
    expect(out).toContain('"Compute at transform time: SELECT DISTINCT ON ..."')
  })

  it('omits applies_to_fields and data_quality_notes when null or empty', () => {
    const tables: ProjectLookupTableRow[] = [
      {
        id: 'lt-3',
        name: 'simple',
        description: null,
        mappings: { a: 'b' },
        applies_to_fields: null,
        data_quality_notes: [],
        customer_approved: true,
      },
    ]
    const out = formatLookupTablesBlock(tables)
    // Header preamble mentions <description> as a guidance hint; check
    // against the per-row XML-tag opening (leading two-space indent makes
    // the row-level tag unique to populated rows).
    expect(out).not.toContain('  <description>')
    expect(out).not.toContain('  <applies_to_fields>')
    expect(out).not.toContain('  <data_quality_notes>')
    expect(out).toContain('customer_approved="true"')
  })

  it('includes applies_to_fields and data_quality_notes when populated', () => {
    const tables: ProjectLookupTableRow[] = [
      {
        id: 'lt-4',
        name: 'rich',
        description: null,
        mappings: { x: 'y' },
        applies_to_fields: [{ source_field_id: 'sf-1', target_field_id: 'tf-1' }],
        data_quality_notes: { unmapped: ['orphan-1', 'orphan-2'] },
        customer_approved: false,
      },
    ]
    const out = formatLookupTablesBlock(tables)
    expect(out).toContain('<applies_to_fields>')
    expect(out).toContain('"source_field_id":"sf-1"')
    expect(out).toContain('<data_quality_notes>')
    expect(out).toContain('"orphan-1"')
  })

  it('escapes XML-special characters in name and description', () => {
    const tables: ProjectLookupTableRow[] = [
      {
        id: 'lt-5',
        name: 'a&b<c>',
        description: 'Note: a < b & c > d',
        mappings: {},
        applies_to_fields: null,
        data_quality_notes: null,
        customer_approved: false,
      },
    ]
    const out = formatLookupTablesBlock(tables)
    expect(out).toContain('name="a&amp;b&lt;c&gt;"')
    expect(out).toContain('<description>Note: a &lt; b &amp; c &gt; d</description>')
  })

  it('emits all rows when multiple provided', () => {
    const tables: ProjectLookupTableRow[] = [
      { id: 'lt-1', name: 'one', description: null, mappings: {}, applies_to_fields: null, data_quality_notes: null, customer_approved: false },
      { id: 'lt-2', name: 'two', description: null, mappings: {}, applies_to_fields: null, data_quality_notes: null, customer_approved: false },
      { id: 'lt-3', name: 'three', description: null, mappings: {}, applies_to_fields: null, data_quality_notes: null, customer_approved: false },
    ]
    const out = formatLookupTablesBlock(tables)
    expect(out.match(/<lookup_table /g)?.length).toBe(3)
  })
})

// ─── formatProjectDecisionsBlock ──────────────────────────────────────────────

describe('formatProjectDecisionsBlock', () => {
  it('returns empty string for empty input', () => {
    expect(formatProjectDecisionsBlock([])).toBe('')
  })

  it('returns empty string when given null-ish array', () => {
    expect(formatProjectDecisionsBlock(undefined as unknown as ProjectDecisionRow[])).toBe('')
  })

  it('emits one <decision> per row with required fields', () => {
    const decisions: ProjectDecisionRow[] = [
      {
        id: 'd-1',
        decision_type: 'duplicate_resolution',
        title: 'Cross-source precedence',
        description: 'BoM vs products precedence',
        ai_recommendation: { option: 'A', summary: 'products.csv wins' },
        alternatives: [{ option: 'B' }],
        customer_decision: null,
        applies_to: { tfm_ids: ['tfm-1', 'tfm-2'] },
        status: 'pending',
      },
    ]
    const out = formatProjectDecisionsBlock(decisions)
    expect(out).toContain('<project_decisions>')
    expect(out).toContain('<decision id="d-1" type="duplicate_resolution" status="pending">')
    expect(out).toContain('<title>Cross-source precedence</title>')
    expect(out).toContain('<description>BoM vs products precedence</description>')
    expect(out).toContain('<ai_recommendation>')
    expect(out).toContain('"option": "A"')
    expect(out).toContain('<alternatives>')
    expect(out).toContain('<applies_to>')
    expect(out).toContain('"tfm-1"')
    expect(out).toContain('</decision>')
  })

  it('emits <customer_decision> when present and omits when null', () => {
    const decided: ProjectDecisionRow = {
      id: 'd-2',
      decision_type: 'schema_interpretation',
      title: 'ICC granularity',
      description: null,
      ai_recommendation: { option: 'A' },
      alternatives: null,
      customer_decision: { chosen: 'A', rationale: 'Aligns with source structure' },
      applies_to: null,
      status: 'decided',
    }
    const pending: ProjectDecisionRow = { ...decided, id: 'd-3', customer_decision: null, status: 'pending' }
    const out = formatProjectDecisionsBlock([decided, pending])
    // The header preamble mentions "<customer_decision>" as guidance; the
    // per-row opening tag is uniquely two-space-indented within a <decision>
    // element.
    expect(out).toContain('  <customer_decision>')
    expect(out).toContain('"chosen": "A"')
    expect(out.match(/^\s{2}<customer_decision>/gm)?.length).toBe(1)
  })

  it('escapes XML-special characters in title and description', () => {
    const decisions: ProjectDecisionRow[] = [
      {
        id: 'd-4',
        decision_type: 'x&y',
        title: 'a < b > c & d',
        description: '<lt>',
        ai_recommendation: {},
        alternatives: null,
        customer_decision: null,
        applies_to: null,
        status: 'pending',
      },
    ]
    const out = formatProjectDecisionsBlock(decisions)
    expect(out).toContain('type="x&amp;y"')
    expect(out).toContain('<title>a &lt; b &gt; c &amp; d</title>')
    expect(out).toContain('<description>&lt;lt&gt;</description>')
  })
})

// ─── formatTransformationIntentBlock ──────────────────────────────────────────

describe('formatTransformationIntentBlock', () => {
  it('returns empty string for null', () => {
    expect(formatTransformationIntentBlock(null)).toBe('')
  })

  it('returns empty string for undefined', () => {
    expect(formatTransformationIntentBlock(undefined)).toBe('')
  })

  it('returns empty string for whitespace-only intent', () => {
    expect(formatTransformationIntentBlock('   \n\t  ')).toBe('')
  })

  it('emits trimmed intent wrapped in tag', () => {
    const intent = '  Apply T-UOM-1 for products-sourced items.  '
    const out = formatTransformationIntentBlock(intent)
    expect(out).toBe(`<transformation_intent>
Apply T-UOM-1 for products-sourced items.
</transformation_intent>`)
  })

  it('preserves multi-line intent text', () => {
    const intent = 'Line one.\nLine two.\nLine three.'
    const out = formatTransformationIntentBlock(intent)
    expect(out).toContain('Line one.\nLine two.\nLine three.')
  })
})
