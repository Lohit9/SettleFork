/**
 * Unit tests for `resolveStaticSourceUnmappedRationale`
 * (`lib/mappings/static-provider.ts`).
 *
 * The helper resolves display-only rationale for unmapped source fields
 * from the static-mappings config. The Rootstock POC org config
 * (`config/static-mappings/98f739b4-…json`) is read from disk by these
 * tests — only the `projects → org_id` Supabase lookup is mocked.
 *
 * It carries NO acknowledgment / decision semantics: it never writes to
 * `source_field_acknowledgments`, it only reads the config file.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveStaticSourceUnmappedRationale } from '@/lib/mappings/static-provider'

// Rootstock POC: org id == the config filename; project id is one of the
// `project_ids` listed in that config's block 0.
const ROOTSTOCK_ORG_ID = '98f739b4-28ab-4be7-b924-d98406371c55'
const ROOTSTOCK_POC_PROJECT_ID = '699fe032-57cb-4f56-a06e-7a2a882f20e1'

/**
 * Minimal Supabase double — satisfies only the chain
 * `resolveStaticOrgMappingForProject` calls:
 *   .from('projects').select('org_id').eq('id', projectId).single()
 * `orgId === null` simulates a missing project / RLS-denied read.
 */
function mockSupabase(orgId: string | null): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            orgId === null
              ? { data: null, error: { message: 'no row' } }
              : { data: { org_id: orgId }, error: null },
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

// Synthetic project schema. Names match the Rootstock config's
// unmapped-source entries (source side real, target side "Unmapped").
const PRODUCTS_TABLE = { id: 'tbl-products', name: 'Products' }
const FIELDS = [
  { id: 'f-product-id', name: 'ProductId', table_id: PRODUCTS_TABLE.id },
  { id: 'f-product-woo-id', name: 'ProductWooId', table_id: PRODUCTS_TABLE.id },
  { id: 'f-product-notes', name: 'ProductNotes', table_id: PRODUCTS_TABLE.id },
  // Not present in the config as an unmapped-source entry.
  { id: 'f-unknown', name: 'NotInConfigColumn', table_id: PRODUCTS_TABLE.id },
]

describe('resolveStaticSourceUnmappedRationale', () => {
  it('maps unmapped-source explanations onto the matching project field ids', async () => {
    const map = await resolveStaticSourceUnmappedRationale(
      mockSupabase(ROOTSTOCK_ORG_ID),
      ROOTSTOCK_POC_PROJECT_ID,
      FIELDS,
      [PRODUCTS_TABLE],
    )

    expect(map.get('f-product-id')?.explanation).toBe(
      'Internal numeric primary key from the source system (Prosys). It has ' +
        'no business meaning outside Prosys and is not needed in Rootstock, ' +
        'which generates its own internal IDs.',
    )
    expect(map.get('f-product-woo-id')?.explanation).toBe(
      "Foreign key linking each product to a WooCommerce entry (RCB's " +
        'e-commerce platform). Relevant only if RCB plans to keep the ' +
        'WooCommerce integration after migration. If not, this field has no ' +
        'destination in Rootstock.',
    )
    expect(map.get('f-product-notes')?.explanation).toBe(
      'Free-text notes. About 30% of rows are null, and most non-null values ' +
        'are whitespace. No standard Notes field exists on the Engineering ' +
        'Item Master import template.',
    )
  })

  it('carries the unmapped-source confidence from the config entry', async () => {
    const map = await resolveStaticSourceUnmappedRationale(
      mockSupabase(ROOTSTOCK_ORG_ID),
      ROOTSTOCK_POC_PROJECT_ID,
      FIELDS,
      [PRODUCTS_TABLE],
    )

    // Rootstock POC config (98f739b4) unmapped-source confidences.
    expect(map.get('f-product-id')?.confidence).toBe(99)
    expect(map.get('f-product-woo-id')?.confidence).toBe(86)
    expect(map.get('f-product-notes')?.confidence).toBe(72)
  })

  it('omits fields with no matching unmapped-source config entry', async () => {
    const map = await resolveStaticSourceUnmappedRationale(
      mockSupabase(ROOTSTOCK_ORG_ID),
      ROOTSTOCK_POC_PROJECT_ID,
      FIELDS,
      [PRODUCTS_TABLE],
    )
    expect(map.has('f-unknown')).toBe(false)
    // Only the three configured fields resolve.
    expect(map.size).toBe(3)
  })

  it('returns an empty map when the project resolves to no org / no config', async () => {
    const map = await resolveStaticSourceUnmappedRationale(
      mockSupabase(null),
      'project-without-org',
      FIELDS,
      [PRODUCTS_TABLE],
    )
    expect(map.size).toBe(0)
  })

  it('returns an empty map when the org has no static config file', async () => {
    const map = await resolveStaticSourceUnmappedRationale(
      mockSupabase('00000000-0000-0000-0000-000000000000'),
      'some-project',
      FIELDS,
      [PRODUCTS_TABLE],
    )
    expect(map.size).toBe(0)
  })

  it('returns an empty map when the project schema has no source fields', async () => {
    const map = await resolveStaticSourceUnmappedRationale(
      mockSupabase(ROOTSTOCK_ORG_ID),
      ROOTSTOCK_POC_PROJECT_ID,
      [],
      [PRODUCTS_TABLE],
    )
    expect(map.size).toBe(0)
  })
})
