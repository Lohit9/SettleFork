import { describe, it, expect } from 'vitest'
import {
  composeTransformUserMessage,
  type TransformUserMessageParts,
} from '@/lib/ai/transform-prompt'
import { TRANSFORM_SYSTEM_PROMPT } from '@/lib/ai/transform-system-prompt'

/**
 * Prompt-shape regression coverage for the transform-generation pipeline.
 *
 * Two surfaces under test:
 *
 *   1. `composeTransformUserMessage` — the deterministic assembler that
 *      stitches together the user message Claude receives. PR ζ adds
 *      per-source-table grouping to <contributing_source_fields>; these
 *      tests pin the grouped vs flat shapes so a future refactor can't
 *      silently revert the cross-table teaching surface.
 *
 *   2. `TRANSFORM_SYSTEM_PROMPT` — the static system prompt. PR ζ
 *      amended rule 6 (bare vs qualified) and added a cross-table
 *      COALESCE few-shot. These tests pin the load-bearing literals so
 *      a future prompt edit that removes the carve-out shows up as a
 *      test failure rather than as a regression of three Rootstock TFMs.
 */

const BASE_PARTS: TransformUserMessageParts = {
  sourceBlock: '<source_field>\nAssy Desc (text)\nTable: Engineering BOM Masters\n</source_field>',
  contributingSourcesBlock: '',
  targetTableName: 'Rootstock_Items',
  targetFieldName: 'Item Description',
  targetDataType: 'text',
  targetInferredType: null,
  targetIsNullable: true,
  checkConstraintLine: '',
  targetCardinalityLine: '',
  typeCompat: 'text → text — direct compatible',
  lookupTablesBlock: '',
  projectDecisionsBlock: '',
  documentationBlock: '',
  intelligenceContext: '',
  iterationBlock: '',
  transformationIntentBlock: '',
  description: 'Carry Assy Desc through with a Products.ProductName fallback.',
  pocBlock: '',
}

describe('composeTransformUserMessage — cross-table source grouping (PR ζ)', () => {
  it('lists fields under multiple "Source table:" headings when the block is grouped (cross-table shape)', () => {
    const crossTableBlock = `\n<contributing_source_fields>
This is a MANY-TO-ONE mapping. Multiple source fields must be combined into a single target field value.

Primary source field: Assy Desc (text)
Contributing source fields:
Source table: Engineering BOM Masters
  Assy Desc (text)
Source table: Products
  ProductName (text)

Generate a SQL expression that COMBINES all source fields into the target field.
Reference source fields using the QUALIFIED "Source Table.Field" form copied verbatim from the headings above (e.g. "Engineering BOM Masters.Assy Desc"). The wrapper rewrites these to LATERAL aliases. NEVER hand-write d./j0./j1. — emit table names; the wrapper translates.
Handle nulls gracefully — if one source field is null, use the remaining field(s).
</contributing_source_fields>\n`

    const message = composeTransformUserMessage({
      ...BASE_PARTS,
      contributingSourcesBlock: crossTableBlock,
    })

    // Both source-table headings must appear so the AI can copy the
    // verbatim qualifier.
    expect(message).toContain('Source table: Engineering BOM Masters')
    expect(message).toContain('Source table: Products')
    // The cross-table reference-style instruction must reach the AI.
    expect(message).toContain('QUALIFIED "Source Table.Field" form')
    expect(message).toContain('NEVER hand-write d./j0./j1.')
  })

  it('keeps the flat reference instruction when the block is same-table or absent (no regression)', () => {
    // Same-table shape: single heading, flat field list.
    const sameTableBlock = `\n<contributing_source_fields>
This is a MANY-TO-ONE mapping. Multiple source fields must be combined into a single target field value.

Primary source field: STATUS (text)
Contributing source fields:
Source table: LOAN_MASTER
  STATUS (text)
  LOAN_TYPE (text)

Generate a SQL expression that COMBINES all source fields into the target field.
Reference source fields by name — they are accessible as row_data->>'field_name'.
Handle nulls gracefully — if one source field is null, use the remaining field(s).
</contributing_source_fields>\n`

    const message = composeTransformUserMessage({
      ...BASE_PARTS,
      contributingSourcesBlock: sameTableBlock,
    })

    expect(message).toContain("row_data->>'field_name'")
    expect(message).not.toContain('QUALIFIED "Source Table.Field" form')
  })

  it('emits no contributing-sources block when it is empty (single-source TFMs and value assignments)', () => {
    const message = composeTransformUserMessage({ ...BASE_PARTS, contributingSourcesBlock: '' })
    expect(message).not.toContain('<contributing_source_fields>')
  })
})

describe('TRANSFORM_SYSTEM_PROMPT — cross-table qualification rule (PR ζ)', () => {
  it('rule 6 instructs CROSS-TABLE TFMs to use the QUALIFIED "Source Table.Field" form', () => {
    // The literal phrase the rule hinges on. Removing this carve-out
    // would re-introduce the Rootstock cross-table apply regression.
    expect(TRANSFORM_SYSTEM_PROMPT).toContain('CROSS-TABLE TFM')
    expect(TRANSFORM_SYSTEM_PROMPT).toMatch(/QUALIFIED .?Source Table\.Field.? form/)
  })

  it('rule 6 preserves the SAME-TABLE bare-name guidance (no regression for single-source TFMs)', () => {
    expect(TRANSFORM_SYSTEM_PROMPT).toContain('SAME-TABLE TFM')
    expect(TRANSFORM_SYSTEM_PROMPT).toContain("row_data->>'field'")
  })

  it('includes a cross-table COALESCE few-shot with Rootstock-shape table names (spaces)', () => {
    // The Rootstock-shape example anchors the qualification pattern for
    // field names with spaces — the failure shape the PR fixes.
    expect(TRANSFORM_SYSTEM_PROMPT).toContain('"Engineering BOM Masters.Assy Desc"')
    expect(TRANSFORM_SYSTEM_PROMPT).toContain('"Products.ProductName"')
  })

  it('forbids hand-written aliases in the few-shot (d./j0./j1.)', () => {
    // The "Wrong (hand-written aliases — never emit d./j0./j1.)" line.
    expect(TRANSFORM_SYSTEM_PROMPT).toMatch(/never emit d\.\/j0\.\/j1\./)
  })

  it('documents that UNION across unrelated source tables is NOT supported (Shape 2 caveat)', () => {
    // Item Number Shape 2 (three-way UNION) is out of scope for PR ζ —
    // the prompt explicitly tells the AI not to invent a UNION subquery
    // so a partial Item Number apply does not regress into hallucinated
    // syntax.
    expect(TRANSFORM_SYSTEM_PROMPT).toMatch(/UNION across multiple unrelated source tables is NOT supported/)
  })
})
