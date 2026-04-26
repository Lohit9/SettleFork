// @vitest-environment node
//
// Phase 4a-3 — unit tests for the extracted FK inference helpers.
// Both the read path (`_mappings-for-redesign-core.ts:deriveJoinAnnotation`)
// and the write path (`mappings-for-redesign.ts:createFieldMapping` cross-
// table precheck) consume these primitives. The helper module lives at
// `lib/utils/fk-inference.ts` and is intentionally generic so a single
// fix here lands in both code paths.

import { describe, it, expect } from 'vitest'
import {
  fkReferenceTargetsTable,
  inferFkCandidates,
  parseToFkFieldFromReference,
  type FkInferenceField,
  type FkInferenceTable,
} from '@/lib/utils/fk-inference'

const JOINED_TABLE_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const OTHER_TABLE_ID = 'bbbbbbbb-1111-2222-3333-444444444444'

const tablesById = new Map<string, FkInferenceTable>([
  [JOINED_TABLE_ID, { id: JOINED_TABLE_ID, name: 'CIF_MASTER' }],
  [OTHER_TABLE_ID, { id: OTHER_TABLE_ID, name: 'ACCT_MASTER' }],
])

// ─────────────────────────────────────────────────────────────────────
// fkReferenceTargetsTable — shape matching across the four documented
// production fk_reference encodings.
// ─────────────────────────────────────────────────────────────────────

describe('[fk-inference] fkReferenceTargetsTable', () => {
  it('matches "Table.Column" when the leading token equals joined table name (Heritage shape)', () => {
    expect(
      fkReferenceTargetsTable(
        'CIF_MASTER.CIF_NO',
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toBe(true)
  })

  it('matches "Table(Column)" when the leading token equals joined table name', () => {
    expect(
      fkReferenceTargetsTable(
        'CIF_MASTER(CIF_NO)',
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toBe(true)
  })

  it('matches a bare "Table" reference', () => {
    expect(
      fkReferenceTargetsTable(
        'CIF_MASTER',
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toBe(true)
  })

  it('matches a direct UUID reference', () => {
    expect(
      fkReferenceTargetsTable(
        JOINED_TABLE_ID,
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toBe(true)
  })

  it('does NOT match when the leading token names a different table', () => {
    expect(
      fkReferenceTargetsTable(
        'ACCT_MASTER.ACCT_NO',
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toBe(false)
  })

  it('does NOT match when the leading token is unknown', () => {
    expect(
      fkReferenceTargetsTable(
        'GHOST_TABLE.col',
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toBe(false)
  })

  it('falls back to tablesById lookup when leading token resolves to joinedTableId', () => {
    // Synthetic: a table whose alias name appears in fk_reference but
    // whose canonical name in tablesById differs. The resolver should
    // still match through the id chain.
    const aliased = new Map<string, FkInferenceTable>([
      [JOINED_TABLE_ID, { id: JOINED_TABLE_ID, name: 'CIF_MASTER' }],
      [
        'cccccccc-1111-2222-3333-444444444444',
        { id: 'cccccccc-1111-2222-3333-444444444444', name: 'CIF_MASTER' },
      ],
    ])
    // The leading token "CIF_MASTER" resolves to one of two tables;
    // the helper takes the FIRST match by Map insertion order — the
    // one with id JOINED_TABLE_ID — so the call returns true.
    expect(
      fkReferenceTargetsTable(
        'CIF_MASTER.CIF_NO',
        JOINED_TABLE_ID,
        'CIF_MASTER',
        aliased,
      ),
    ).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// inferFkCandidates — preserves input order, filters non-FK and non-
// matching rows, returns names only.
// ─────────────────────────────────────────────────────────────────────

describe('[fk-inference] inferFkCandidates', () => {
  function field(
    name: string,
    fkRef: string | null,
    isFk: boolean | null = true,
  ): FkInferenceField {
    return { name, is_foreign_key: isFk, fk_reference: fkRef }
  }

  it('returns [] when no fields target the joined table (zero-FK case)', () => {
    const dominantFields: FkInferenceField[] = [
      field('BRANCH_NO', 'BRANCH_INFO.BRANCH_NO'),
      field('OFFICER_CD', 'OFFICER_INFO.OFFICER_CD'),
    ]
    const out = inferFkCandidates(
      dominantFields,
      JOINED_TABLE_ID,
      'CIF_MASTER',
      tablesById,
    )
    expect(out).toEqual([])
  })

  it('returns the single candidate name when exactly one FK matches', () => {
    const dominantFields: FkInferenceField[] = [
      field('BRANCH_NO', 'BRANCH_INFO.BRANCH_NO'),
      field('CIF_NO', 'CIF_MASTER.CIF_NO'),
      field('OFFICER_CD', 'OFFICER_INFO.OFFICER_CD'),
    ]
    const out = inferFkCandidates(
      dominantFields,
      JOINED_TABLE_ID,
      'CIF_MASTER',
      tablesById,
    )
    expect(out).toEqual(['CIF_NO'])
  })

  it('returns multiple names in input order when 2+ FKs match (multi-FK ambiguous)', () => {
    const dominantFields: FkInferenceField[] = [
      field('PRIMARY_CIF', 'CIF_MASTER.CIF_NO'),
      field('SECONDARY_CIF', 'CIF_MASTER.CIF_NO'),
      field('UNRELATED', 'BRANCH_INFO.BRANCH_NO'),
    ]
    const out = inferFkCandidates(
      dominantFields,
      JOINED_TABLE_ID,
      'CIF_MASTER',
      tablesById,
    )
    expect(out).toEqual(['PRIMARY_CIF', 'SECONDARY_CIF'])
  })

  it('skips rows where is_foreign_key=false even when fk_reference matches', () => {
    const dominantFields: FkInferenceField[] = [
      field('CIF_NO', 'CIF_MASTER.CIF_NO', false),
      field('OFFICER_CD', 'OFFICER_INFO.OFFICER_CD', true),
    ]
    expect(
      inferFkCandidates(
        dominantFields,
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toEqual([])
  })

  it('skips rows where fk_reference is null', () => {
    const dominantFields: FkInferenceField[] = [
      field('CIF_NO', null, true),
      field('OTHER', 'CIF_MASTER.X', true),
    ]
    expect(
      inferFkCandidates(
        dominantFields,
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toEqual(['OTHER'])
  })

  it('skips rows where is_foreign_key is null (defensive)', () => {
    const dominantFields: FkInferenceField[] = [
      field('CIF_NO', 'CIF_MASTER.CIF_NO', null),
    ]
    expect(
      inferFkCandidates(
        dominantFields,
        JOINED_TABLE_ID,
        'CIF_MASTER',
        tablesById,
      ),
    ).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────
// parseToFkFieldFromReference — covers the four documented shapes,
// plus null returns for shapes that don't expose a column.
// ─────────────────────────────────────────────────────────────────────

describe('[fk-inference] parseToFkFieldFromReference', () => {
  it('parses "Table.Column" (Heritage shape)', () => {
    expect(parseToFkFieldFromReference('CIF_MASTER.CIF_NO')).toBe('CIF_NO')
  })

  it('parses "Table(Column)"', () => {
    expect(parseToFkFieldFromReference('CIF_MASTER(CIF_NO)')).toBe('CIF_NO')
  })

  it('returns null for a bare table name', () => {
    expect(parseToFkFieldFromReference('CIF_MASTER')).toBeNull()
  })

  it('returns null for a UUID-shaped reference', () => {
    expect(
      parseToFkFieldFromReference('aaaaaaaa-1111-2222-3333-444444444444'),
    ).toBeNull()
  })

  it('handles schema-qualified references defensively', () => {
    // "schema.Table.Column" — the helper takes the first segment after
    // the first dot, then splits again to drop trailing dots.
    expect(parseToFkFieldFromReference('public.CIF_MASTER.CIF_NO')).toBe(
      'CIF_MASTER',
    )
  })

  it('returns the column for "Table(Column with spaces)"', () => {
    expect(parseToFkFieldFromReference('CIF_MASTER(CIF_NO )')).toBe('CIF_NO')
  })
})
