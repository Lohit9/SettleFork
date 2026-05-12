// @vitest-environment node
//
// PR 1 — Transform agent context blocks. Tests:
//
//   A. composeTransformUserMessage byte-level snapshots — locks the
//      assembly order (POC last, before TASK).
//      A.1  Single-source mapped TFM with all blocks populated.
//      A.2  VA TFM with intent + decisions but no POC.
//
//   B. autoGenerateAllTransforms VA-skip wiring (source-level).
//
//   C. generateTransform + suggestTransformDescription wiring (source-
//      level) — verifies the 4 new helpers are called and the projects
//      tables (project_decisions, project_lookup_tables) are fetched.
//
// The Test-#7 snapshot is the "canonical" shape used in production demo
// prep; if the format changes intentionally, re-baseline both expected
// strings and confirm the prompt the LLM sees in a smoke check before
// merging.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { composeTransformUserMessage } from '@/lib/ai/transform-prompt'
import {
  formatLookupTablesBlock,
  formatProjectDecisionsBlock,
  formatTransformationIntentBlock,
} from '@/lib/ai/project-context-blocks'
import { formatPocAnswerKeyBlock } from '@/lib/ai/context-builder'

const TRANSFORMS_PATH = resolve(__dirname, '../../lib/actions/transformations.ts')
const TRANSFORMS_SRC = readFileSync(TRANSFORMS_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0) throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─── A. composeTransformUserMessage snapshots ────────────────────────────────

describe('[transformations-context] A — composeTransformUserMessage snapshots', () => {
  it('A.1 — single-source mapped TFM with all blocks populated; POC is last', () => {
    const lookupTablesBlock = formatLookupTablesBlock([
      {
        id: 'lt-1',
        name: 'uom_normalization',
        description: 'Maps source UOMs to Rootstock External Ids',
        mappings: { Each: 'EA', Lbs: 'LB' },
        applies_to_fields: null,
        data_quality_notes: null,
        customer_approved: false,
      },
    ])
    const projectDecisionsBlock = formatProjectDecisionsBlock([
      {
        id: 'd-1',
        decision_type: 'duplicate_resolution',
        title: 'Cross-source precedence',
        description: null,
        ai_recommendation: { option: 'A' },
        alternatives: null,
        customer_decision: null,
        applies_to: { tfm_ids: ['tfm-1'] },
        status: 'pending',
      },
    ])
    const transformationIntentBlock = formatTransformationIntentBlock(
      'Apply T-UOM-1 for products-sourced items.',
    )
    const pocBlock = formatPocAnswerKeyBlock('# Rootstock POC\nDivision: DIV1')

    const out = composeTransformUserMessage({
      sourceBlock: '<source_field>\nProductUnitsName (text)\n</source_field>',
      contributingSourcesBlock: '',
      targetTableName: 'rstk__peitem',
      targetFieldName: 'rstk__peitem_enguom__r_external_id',
      targetDataType: 'VARCHAR(40)',
      targetInferredType: 'external_id',
      targetIsNullable: false,
      checkConstraintLine: '',
      targetCardinalityLine: 'Distinct values: 3',
      typeCompat: 'String → External ID via lookup',
      lookupTablesBlock,
      projectDecisionsBlock,
      documentationBlock: '\n<documentation>\nSchema docs go here.\n</documentation>\n',
      intelligenceContext: '',
      iterationBlock: '',
      transformationIntentBlock,
      description: 'Map ProductUnitsName via T-UOM-1 lookup',
      pocBlock,
    })

    // Order: source → target → type_compat → lookup → decisions → docs → intent → description → POC → TASK
    // The lookup_tables preamble mentions <transformation_intent> and
    // <description> as guidance hints; match each block's OPENING tag (line-
    // start, no leading whitespace) to skip the in-text references.
    const positions = {
      source: out.indexOf('<source_field>'),
      target: out.indexOf('<target_field>'),
      typeCompat: out.indexOf('<type_compatibility>'),
      lookup: out.indexOf('\n<lookup_tables>\n'),
      decisions: out.indexOf('\n<project_decisions>\n'),
      docs: out.indexOf('\n<documentation>\n'),
      intent: out.indexOf('\n<transformation_intent>\n'),
      description: out.indexOf('\n<description>\n'),
      poc: out.indexOf('\n<poc_answer_key authoritative="true">\n'),
      task: out.indexOf('Generate the SQL transformation expression.'),
    }
    expect(positions.source).toBeGreaterThanOrEqual(0)
    expect(positions.target).toBeGreaterThan(positions.source)
    expect(positions.typeCompat).toBeGreaterThan(positions.target)
    expect(positions.lookup).toBeGreaterThan(positions.typeCompat)
    expect(positions.decisions).toBeGreaterThan(positions.lookup)
    expect(positions.docs).toBeGreaterThan(positions.decisions)
    expect(positions.intent).toBeGreaterThan(positions.docs)
    expect(positions.description).toBeGreaterThan(positions.intent)
    expect(positions.poc).toBeGreaterThan(positions.description)
    expect(positions.task).toBeGreaterThan(positions.poc)

    // POC is the LAST non-TASK content. No other block opens between POC and TASK.
    const between = out.slice(positions.poc, positions.task)
    expect(between).not.toContain('\n<lookup_tables>\n')
    expect(between).not.toContain('\n<project_decisions>\n')
    expect(between).not.toContain('\n<transformation_intent>\n')
    expect(between).not.toContain('\n<description>\n')

    // Snapshot the assembled message verbatim for byte-level pin.
    expect(out).toMatchInlineSnapshot(`
      "<source_field>
      ProductUnitsName (text)
      </source_field>

      <target_field>
      Field: rstk__peitem.rstk__peitem_enguom__r_external_id
      Type: VARCHAR(40) (external_id)
      Nullable: false
      Distinct values: 3
      </target_field>

      <type_compatibility>
      String → External ID via lookup
      </type_compatibility>

      <lookup_tables>
      The following lookup / code-mapping tables have been defined for this project
      by the upstream mapping pass. Each table's <mappings> is the literal
      source→target value dictionary (object form) OR a free-text rule describing
      a runtime computation (string form). When the per-TFM <transformation_intent>
      or <description> refers to a value mapping (UOM normalization, status codes,
      ICC group expansion, etc.), check whether one of these tables covers it
      before inventing a CASE expression. Use the listed mappings verbatim — do
      not paraphrase or add unlisted entries.

      <lookup_table id="lt-1" name="uom_normalization" customer_approved="false">
        <description>Maps source UOMs to Rootstock External Ids</description>
        <mappings>{
        "Each": "EA",
        "Lbs": "LB"
      }</mappings>
      </lookup_table>
      </lookup_tables>

      <project_decisions>
      The following business decisions have been recorded for this project. When a
      decision has a non-null <customer_decision> (status=decided or auto_applied),
      treat that resolved outcome as authoritative for any transformation it
      applies to. When status=pending, treat <ai_recommendation> as a strong
      default unless the per-TFM <transformation_intent> or <description>
      contradicts it.

      <decision id="d-1" type="duplicate_resolution" status="pending">
        <title>Cross-source precedence</title>
        <ai_recommendation>{
        "option": "A"
      }</ai_recommendation>
        <applies_to>{"tfm_ids":["tfm-1"]}</applies_to>
      </decision>
      </project_decisions>

      <documentation>
      Schema docs go here.
      </documentation>

      <transformation_intent>
      Apply T-UOM-1 for products-sourced items.
      </transformation_intent>

      <description>
      Map ProductUnitsName via T-UOM-1 lookup
      </description>

      <poc_answer_key authoritative="true">
      The following project-specific answer key takes precedence over general
      guidance in the system prompt and any earlier document blocks. Generate
      mapping output (target_field_mappings, mapping_sources, project_decisions,
      project_lookup_tables, project_data_quality_issues, target_field_coverage,
      project_inferred_targets, project_notes) matching this specification.

      # Rootstock POC
      Division: DIV1
      </poc_answer_key>

      Generate the SQL transformation expression."
    `)
  })

  it('A.2 — VA TFM with intent + decisions, no POC, no lookup tables, no documentation', () => {
    const projectDecisionsBlock = formatProjectDecisionsBlock([
      {
        id: 'd-2',
        decision_type: 'constant_value',
        title: 'Default responsible engineer for items',
        description: null,
        ai_recommendation: { value: '1990' },
        alternatives: null,
        customer_decision: { chosen: '1990', rationale: 'Customer-specified placeholder' },
        applies_to: null,
        status: 'decided',
      },
    ])
    const transformationIntentBlock = formatTransformationIntentBlock(
      "T-CONST: literal '1990' placeholder.",
    )

    const out = composeTransformUserMessage({
      sourceBlock:
        '<source_field>\nNo source field — this is a VALUE ASSIGNMENT.\n</source_field>',
      contributingSourcesBlock: '',
      targetTableName: 'rstk__peitem',
      targetFieldName: 'rstk__peitem_respeng__r_external_id',
      targetDataType: 'VARCHAR(40)',
      targetInferredType: null,
      targetIsNullable: false,
      checkConstraintLine: '',
      targetCardinalityLine: '',
      typeCompat: null,
      lookupTablesBlock: '',
      projectDecisionsBlock,
      documentationBlock: '',
      intelligenceContext: '',
      iterationBlock: '',
      transformationIntentBlock,
      description: 'Assign constant value 1990',
      pocBlock: '',
    })

    expect(out).toContain('<project_decisions>')
    expect(out).toContain("T-CONST: literal '1990' placeholder.")
    expect(out).toContain('Customer-specified placeholder')
    // No POC, no lookup, no docs → no orphan block markers.
    expect(out).not.toContain('<poc_answer_key')
    expect(out).not.toContain('<lookup_tables>')
    expect(out).not.toContain('<documentation>')
    // type_compatibility defaults to "Not specified" when typeCompat is null.
    expect(out).toContain('Not specified')
    // TASK present at the end.
    expect(out.trimEnd().endsWith('Generate the SQL transformation expression.')).toBe(true)
  })
})

// ─── B. autoGenerateAllTransforms VA-skip wiring (source-level) ──────────────

const AUTOGEN_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function autoGenerateAllTransforms(',
  'export async function applyTransform(',
)

describe('[transformations-context] B — autoGenerateAllTransforms VA-skip', () => {
  it('B.1 — `skipped` field is part of the return envelope type', () => {
    expect(AUTOGEN_BODY).toMatch(/skipped\?:\s*number/)
  })

  it('B.2 — only VAs are candidates for the skip filter', () => {
    expect(AUTOGEN_BODY).toMatch(/\.filter\(\s*\(f\)\s*=>\s*f\.isValueAssignment\s*\)/)
  })

  it('B.3 — combination_sql is the predicate; both null and empty trigger generation', () => {
    // Skip when combination_sql != null AND non-empty (trimmed > 0).
    // Use [\s\S]* instead of the `s` flag for pre-ES2018 target compat.
    expect(AUTOGEN_BODY).toMatch(/combination_sql[\s\S]*!=\s*null/)
    expect(AUTOGEN_BODY).toMatch(/combination_sql[\s\S]*trim\(\)\.length\s*>\s*0/)
  })

  it('B.4 — skipped is returned in both empty and non-empty success cases', () => {
    expect(AUTOGEN_BODY).toMatch(/success:\s*true,\s*generated:\s*0,\s*failed:\s*0,\s*skipped:\s*0/)
    expect(AUTOGEN_BODY).toMatch(/return\s*\{\s*success:\s*true,\s*generated,\s*failed,\s*skipped\s*\}/)
  })

  it('B.5 — per-row generateTransform invocation path is unchanged for VAs (no early return)', () => {
    // The skip is implemented as a `continue` inside the iteration loop —
    // not as an early return — so generateTransform stays callable for VAs
    // when invoked directly elsewhere.
    expect(AUTOGEN_BODY).toMatch(/skipped\+\+\s*\n\s*continue/)
  })
})

// ─── C. generateTransform + suggestTransformDescription wiring ───────────────

const GENERATE_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function generateTransform(',
  'export async function updateTransformSQL(',
)
const SUGGEST_BODY = sliceBetween(
  TRANSFORMS_SRC,
  'export async function suggestTransformDescription(',
  'export async function dismissTransformNeeded',
)

describe('[transformations-context] C — generateTransform wiring', () => {
  it('C.1 — fetches project decisions + lookup_tables via loadProjectContextBlocks', () => {
    expect(GENERATE_BODY).toContain('loadProjectContextBlocks(ctx.projectId)')
  })

  it('C.2 — formats all 4 new blocks (lookup, decisions, intent, POC)', () => {
    expect(GENERATE_BODY).toContain('formatLookupTablesBlock(')
    expect(GENERATE_BODY).toContain('formatProjectDecisionsBlock(')
    expect(GENERATE_BODY).toContain('formatTransformationIntentBlock(')
    expect(GENERATE_BODY).toContain('formatPocAnswerKeyBlock(')
  })

  it('C.3 — uses resolveTransformationIntent (intent + ai_reasoning fallback)', () => {
    expect(GENERATE_BODY).toMatch(
      /resolveTransformationIntent\s*\(\s*ctx\.tfm\.transformation_intent\s*,\s*ctx\.tfm\.ai_reasoning/,
    )
  })

  it('C.4 — assembles user message via composeTransformUserMessage', () => {
    expect(GENERATE_BODY).toContain('composeTransformUserMessage({')
  })

  it('C.5 — DEBUG_TRANSFORM_PROMPT gate is wired', () => {
    expect(GENERATE_BODY).toMatch(/process\.env\.DEBUG_TRANSFORM_PROMPT\s*===\s*'1'/)
  })
})

describe('[transformations-context] C — suggestTransformDescription wiring', () => {
  it('C.6 — fetches the same project blocks (loadProjectContextBlocks)', () => {
    expect(SUGGEST_BODY).toContain('loadProjectContextBlocks(ctx.projectId)')
  })

  it('C.7 — formats all 4 new blocks (parity with generateTransform)', () => {
    expect(SUGGEST_BODY).toContain('formatLookupTablesBlock(')
    expect(SUGGEST_BODY).toContain('formatProjectDecisionsBlock(')
    expect(SUGGEST_BODY).toContain('formatTransformationIntentBlock(')
    expect(SUGGEST_BODY).toContain('formatPocAnswerKeyBlock(')
  })

  it('C.8 — POC block is positioned after intent (last non-TASK block)', () => {
    const pocIdx = SUGGEST_BODY.indexOf('${pocBlock')
    const intentIdx = SUGGEST_BODY.indexOf('${transformationIntentBlock')
    const taskIdx = SUGGEST_BODY.indexOf(
      'Suggest a transformation description for this field mapping.',
    )
    expect(pocIdx).toBeGreaterThan(intentIdx)
    expect(taskIdx).toBeGreaterThan(pocIdx)
  })
})
