import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  flattenTfmsForInFlightChecks,
  type InFlightCheckContext,
} from '@/lib/quality/_detection-engine-core'

/**
 * Source-level invariants for the Prompt-3d Option A rewrite of the
 * in-flight detection engine (`lib/quality/_detection-engine-core.ts`).
 *
 * Fanout policy being guarded:
 *   - hasStaged=true  → primary-only, 1 context per TFM (fixes legacy
 *                       N-duplicate bug on multi-source TFMs).
 *   - hasStaged=false → iterate all mapping_sources, 1 context per MS
 *                       (preserves legacy per-contributor source-branch
 *                       attribution).
 *
 * Rename guarded: legacy iteration surface used `fm_id`; the Option A
 * context uses `tfm_id`. No check helper should ever reach for a legacy
 * `fm_id` field again.
 */

const CORE_PATH = resolve(__dirname, '../../lib/quality/_detection-engine-core.ts')
const WRAPPER_PATH = resolve(__dirname, '../../lib/quality/detection-engine.ts')
const CORE_SRC = readFileSync(CORE_PATH, 'utf8')
const WRAPPER_SRC = readFileSync(WRAPPER_PATH, 'utf8')

// ── Source-level zero-legacy-ref guards ─────────────────────────────────────

describe('[detection-engine refinements] zero legacy refs in core', () => {
  it('no .from(field_mappings) calls', () => {
    expect(CORE_SRC).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
  })

  it('no .from(field_acknowledgments) calls', () => {
    expect(CORE_SRC).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
  })

  it('no references to legacy field_mapping_id column', () => {
    expect(CORE_SRC).not.toMatch(/field_mapping_id/)
  })

  it('no residual `fm_id` identifiers as property/parameter — renamed to `tfm_id`', () => {
    // Guard against the legacy identifier in CODE — property declarations,
    // property access, and destructuring. A historical mention inside a
    // docblock (e.g. `…renamed fm_id → tfm_id…`) is explicitly allowed and
    // excluded via comment stripping below.
    const codeOnly = CORE_SRC
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/[^\n]*/g, '') // line comments
    expect(codeOnly).not.toMatch(/\bfm_id\s*[:.,)]/) // property/param use
    expect(codeOnly).not.toMatch(/\.fm_id\b/) // property access
    expect(codeOnly).not.toMatch(/\{\s*fm_id\b/) // destructuring
    // tfm_id MUST be present in code (InFlightCheckContext + usage).
    expect(codeOnly).toMatch(/\btfm_id\b/)
  })
})

describe('[detection-engine refinements] zero legacy refs in wrapper', () => {
  it('wrapper does not reach into legacy tables either', () => {
    expect(WRAPPER_SRC).not.toMatch(/\.from\(\s*['"]field_mappings['"]/)
    expect(WRAPPER_SRC).not.toMatch(/\.from\(\s*['"]field_acknowledgments['"]/)
    expect(WRAPPER_SRC).not.toMatch(/field_mapping_id/)
    expect(WRAPPER_SRC).not.toMatch(/\bfm_id\b/)
  })
})

describe('[detection-engine refinements] new-model query shape', () => {
  it('fetches TFMs with mapping_sources + nested source_field + target_field + transformations', () => {
    expect(CORE_SRC).toMatch(/\.from\(\s*['"]target_field_mappings['"]/)
    expect(CORE_SRC).toMatch(/mapping_sources\s*\(/)
    expect(CORE_SRC).toMatch(/source_field:\s*fields!source_field_id/)
    expect(CORE_SRC).toMatch(/target_field:\s*fields!target_field_id/)
    expect(CORE_SRC).toMatch(/transformations\s*\(/)
  })

  it('Check 12 counts target_field_mappings with an inner mapping_sources join (preserve-legacy Q2)', () => {
    // The Q2 decision: bare-ack TFMs (no MS) must still trigger
    // unmapped_required. The !inner join enforces that.
    expect(CORE_SRC).toMatch(
      /target_field_mappings[\s\S]*?mapping_sources!inner[\s\S]*?count:\s*['"]exact['"]/
    )
  })

  it('documents the Option A + Q2 preserve-legacy decisions inline', () => {
    expect(CORE_SRC).toMatch(/Option A/)
    expect(CORE_SRC).toMatch(/Prompt 3d/)
    // Q2 comment for acknowledged-but-unmapped Check 12 behaviour.
    expect(CORE_SRC).toMatch(/Q2/)
  })
})

// ── Behavioural tests on the flattener ──────────────────────────────────────

const projectId = 'project-123'

function makeTfm(opts: {
  id: string
  targetField: { id: string; table_id: string }
  mappingSources: Array<{
    ordinal: number
    source_table_id: string | null
    source_field: { id: string; name: string } | null
  }>
  needs_transformation?: boolean | null
  transformStatus?: string | null
}) {
  return {
    id: opts.id,
    target_field_id: opts.targetField.id,
    needs_transformation: opts.needs_transformation ?? null,
    mapping_sources: opts.mappingSources.map((ms, i) => ({
      id: `ms-${opts.id}-${i}`,
      source_table_id: ms.source_table_id,
      ordinal: ms.ordinal,
      source_field: ms.source_field
        ? {
            id: ms.source_field.id,
            name: ms.source_field.name,
            data_type: 'TEXT',
            inferred_type: 'string',
            is_nullable: true,
            is_primary_key: false,
            table_id: ms.source_table_id ?? 't?',
          }
        : null,
    })),
    target_field: {
      id: opts.targetField.id,
      name: `tf-${opts.targetField.id}`,
      data_type: 'TEXT',
      is_nullable: true,
      is_foreign_key: false,
      fk_reference: null,
      table_id: opts.targetField.table_id,
    },
    transformations: opts.transformStatus
      ? [{ id: `tr-${opts.id}`, status: opts.transformStatus }]
      : [],
  }
}

const S1 = 'src-table-1'
const S2 = 'src-table-2'
const T1 = 'tgt-table-1'

const tms = [
  { id: 'tm-1', project_id: projectId, source_table_id: S1, target_table_id: T1 },
  { id: 'tm-2', project_id: projectId, source_table_id: S2, target_table_id: T1 },
]

describe('[detection-engine refinements] flattenTfmsForInFlightChecks — Option A fanout', () => {
  it('hasStaged=true + multi-source TFM → exactly 1 primary-only context (fixes legacy duplicate bug)', () => {
    const tfm = makeTfm({
      id: 'tfm-multi',
      targetField: { id: 'tf-1', table_id: T1 },
      mappingSources: [
        { ordinal: 0, source_table_id: S1, source_field: { id: 'sf-primary', name: 'primary' } },
        {
          ordinal: 1,
          source_table_id: S1,
          source_field: { id: 'sf-contrib-a', name: 'contrib_a' },
        },
        {
          ordinal: 2,
          source_table_id: S1,
          source_field: { id: 'sf-contrib-b', name: 'contrib_b' },
        },
      ],
    })

    // tm-1 has staged rows.
    const staged = new Set<string>(['tm-1'])

    const contexts = flattenTfmsForInFlightChecks(
      projectId,
      [tfm] as unknown as Parameters<typeof flattenTfmsForInFlightChecks>[1],
      tms,
      staged
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].tfm_id).toBe('tfm-multi')
    expect(contexts[0].hasStaged).toBe(true)
    expect(contexts[0].source_field.id).toBe('sf-primary')
  })

  it('hasStaged=false + multi-source TFM → one context per mapping_source (preserves per-contributor)', () => {
    const tfm = makeTfm({
      id: 'tfm-multi',
      targetField: { id: 'tf-1', table_id: T1 },
      mappingSources: [
        { ordinal: 0, source_table_id: S1, source_field: { id: 'sf-primary', name: 'primary' } },
        {
          ordinal: 1,
          source_table_id: S1,
          source_field: { id: 'sf-contrib-a', name: 'contrib_a' },
        },
        {
          ordinal: 2,
          source_table_id: S1,
          source_field: { id: 'sf-contrib-b', name: 'contrib_b' },
        },
      ],
    })

    const contexts = flattenTfmsForInFlightChecks(
      projectId,
      [tfm] as unknown as Parameters<typeof flattenTfmsForInFlightChecks>[1],
      tms,
      new Set<string>() // no staged
    )

    expect(contexts).toHaveLength(3)
    expect(contexts.every((c) => c.tfm_id === 'tfm-multi')).toBe(true)
    expect(contexts.every((c) => c.hasStaged === false)).toBe(true)
    expect(contexts.map((c) => c.source_field.id)).toEqual([
      'sf-primary',
      'sf-contrib-a',
      'sf-contrib-b',
    ])
  })

  it('bare-ack TFM (zero mapping_sources) emits NO context for per-TFM checks', () => {
    const tfm = makeTfm({
      id: 'tfm-bare',
      targetField: { id: 'tf-1', table_id: T1 },
      mappingSources: [],
    })

    const contexts = flattenTfmsForInFlightChecks(
      projectId,
      [tfm] as unknown as Parameters<typeof flattenTfmsForInFlightChecks>[1],
      tms,
      new Set<string>()
    )

    expect(contexts).toHaveLength(0)
  })

  it('orphan TFM (no matching TM for its primary source_table/target_table pair) is skipped', () => {
    const tfm = makeTfm({
      id: 'tfm-orphan',
      targetField: { id: 'tf-1', table_id: T1 },
      mappingSources: [
        { ordinal: 0, source_table_id: 'src-unknown', source_field: { id: 'sf', name: 's' } },
      ],
    })

    const contexts = flattenTfmsForInFlightChecks(
      projectId,
      [tfm] as unknown as Parameters<typeof flattenTfmsForInFlightChecks>[1],
      tms,
      new Set<string>()
    )

    expect(contexts).toHaveLength(0)
  })

  it('single-source TFM on staged branch → 1 context (unchanged from legacy)', () => {
    const tfm = makeTfm({
      id: 'tfm-single',
      targetField: { id: 'tf-1', table_id: T1 },
      mappingSources: [
        { ordinal: 0, source_table_id: S1, source_field: { id: 'sf', name: 'single' } },
      ],
    })

    const contexts = flattenTfmsForInFlightChecks(
      projectId,
      [tfm] as unknown as Parameters<typeof flattenTfmsForInFlightChecks>[1],
      tms,
      new Set<string>(['tm-1'])
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].hasStaged).toBe(true)
    expect(contexts[0].tm_id).toBe('tm-1')
  })

  it('single-source TFM on source branch → 1 context (unchanged from legacy)', () => {
    const tfm = makeTfm({
      id: 'tfm-single',
      targetField: { id: 'tf-1', table_id: T1 },
      mappingSources: [
        { ordinal: 0, source_table_id: S1, source_field: { id: 'sf', name: 'single' } },
      ],
    })

    const contexts = flattenTfmsForInFlightChecks(
      projectId,
      [tfm] as unknown as Parameters<typeof flattenTfmsForInFlightChecks>[1],
      tms,
      new Set<string>()
    )

    expect(contexts).toHaveLength(1)
    expect(contexts[0].hasStaged).toBe(false)
  })

  it('propagates needs_transformation + transform_status onto every context', () => {
    const tfm = makeTfm({
      id: 'tfm',
      targetField: { id: 'tf-1', table_id: T1 },
      mappingSources: [
        { ordinal: 0, source_table_id: S1, source_field: { id: 'sf-p', name: 'p' } },
        { ordinal: 1, source_table_id: S1, source_field: { id: 'sf-c', name: 'c' } },
      ],
      needs_transformation: true,
      transformStatus: 'applied',
    })

    const contexts = flattenTfmsForInFlightChecks(
      projectId,
      [tfm] as unknown as Parameters<typeof flattenTfmsForInFlightChecks>[1],
      tms,
      new Set<string>() // source branch → 2 contexts
    )

    expect(contexts).toHaveLength(2)
    expect(contexts.every((c) => c.needs_transformation === true)).toBe(true)
    expect(contexts.every((c) => c.transform_status === 'applied')).toBe(true)
  })
})

// ── InFlightCheckContext shape (compile-time only, no runtime assertions) ───

describe('[detection-engine refinements] InFlightCheckContext shape', () => {
  it('exposes the rename fm_id → tfm_id at the type level', () => {
    // Pure compile-time check: if the rename ever regresses, TS would fail.
    const ctx: InFlightCheckContext = {
      tfm_id: 'x',
      tm_id: 'y',
      project_id: 'z',
      source_table_id: 's',
      target_table_id: 't',
      source_field: {
        id: 'sf',
        name: 'sf',
        data_type: 'TEXT',
        inferred_type: null,
        is_nullable: true,
        is_primary_key: false,
        table_id: 's',
      },
      target_field: {
        id: 'tf',
        name: 'tf',
        data_type: 'TEXT',
        is_nullable: true,
        is_foreign_key: false,
        fk_reference: null,
        table_id: 't',
      },
      needs_transformation: null,
      transform_status: null,
      hasStaged: false,
    }
    expect(ctx.tfm_id).toBe('x')
  })
})
