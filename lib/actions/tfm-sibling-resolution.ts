/**
 * PR Ω.3.8.1 — Resolve all TFM ids that share the canonical TFM's
 * (target_field_id, source_signature) collapse key.
 *
 * Background. Post-Ω.3.8 the Mapping First view collapses N partition
 * TFMs into one row when they share a target_field + the same ordered
 * tuple of source_field_ids (the "collapse key"). Status mutation
 * handlers historically operate on the canonical TFM only, leaving
 * sibling TFMs in their pre-update state. That produces a counter
 * divergence between the mapping page (row-level) and the Migration
 * Center (per-TFM via `stat-formulas.ts` `mappingApproved`). This
 * helper closes that gap by enumerating the sibling set so mutations
 * can fan out atomically.
 *
 * Collapse-key semantics (matches the assembler at
 * `lib/ai/mapping-engine.ts` per-target-field loop):
 *
 *   • Two TFMs are siblings iff they share `(project_id,
 *     target_field_id)` AND their ordered `source_field_id` tuples
 *     are identical.
 *
 *   • The ordered tuple is `array_agg(source_field_id ORDER BY ordinal)`
 *     in SQL terms; computed in JS here because Supabase's JS client
 *     can't express the equality directly. Equality uses the JS `===`
 *     for each position — NULL == NULL in JS, matching PostgreSQL's
 *     `IS NOT DISTINCT FROM`.
 *
 *   • VAs: both signatures are empty arrays → equal → siblings.
 *
 *   • Mapped (single source): single-element arrays `[A]` == `[A]`.
 *
 *   • Mapped (multi-source): order matters by ordinal, so `[A, B]` !=
 *     `[B, A]` and `[A, B]` != `[A, C]` (the concat_* edge case from
 *     the user spec — different secondary sources mean different
 *     collapse keys).
 *
 * The helper returns the canonical TFM in the result set; callers
 * typically apply a bulk operation to the full set (e.g.
 * `.in('id', siblings.map(s => s.id))`).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Subset of `target_field_mappings` columns surfaced to callers. */
export interface ResolvedSiblingTfm {
  id: string
  /** Pre-mutation status — useful for per-TFM audit (`ai_edit_history`). */
  status: 'needs_review' | 'approved' | 'rejected' | string
}

interface CandidateRow {
  id: string
  status: string
  mapping_sources: Array<{ source_field_id: string | null; ordinal: number }> | null
}

/**
 * Compute the ordered source signature for a TFM. Mirrors the
 * assembler's bucketing: ordinal ASC, source_field_id at each
 * position.
 */
function sourceSignature(
  sources: ReadonlyArray<{ source_field_id: string | null; ordinal: number }>,
): ReadonlyArray<string | null> {
  return [...sources]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s) => s.source_field_id)
}

function signaturesEqual(
  a: ReadonlyArray<string | null>,
  b: ReadonlyArray<string | null>,
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    // `null === null` in JS, matching IS NOT DISTINCT FROM semantics.
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Resolve the sibling TFM set for the given canonical TFM. The result
 * ALWAYS includes the canonical (so single-partition / heritage rows
 * yield a length-1 array — byte-identical to the pre-Ω.3.8.1 single-
 * update path when callers do `.in('id', ...)`).
 *
 * Throws on DB error. Returns an empty array only if the canonical
 * itself can't be found (caller treats that as a defensive no-op).
 */
export async function resolveSiblingTfms(
  client: SupabaseClient,
  args: {
    canonicalTfmId: string
    projectId: string
    targetFieldId: string
  },
): Promise<ResolvedSiblingTfm[]> {
  // Single round-trip: fetch all candidate TFMs for the target field
  // along with their mapping_sources rows. Postgres handles the join
  // server-side; in JS we filter to the canonical's signature.
  const { data, error } = await client
    .from('target_field_mappings')
    .select('id, status, mapping_sources(source_field_id, ordinal)')
    .eq('project_id', args.projectId)
    .eq('target_field_id', args.targetFieldId)
  if (error) {
    throw new Error(
      `[tfm-sibling-resolution] candidate fetch failed for ` +
        `target_field_id=${args.targetFieldId}: ${error.message}`,
    )
  }
  const candidates = (data ?? []) as CandidateRow[]
  const canonical = candidates.find((c) => c.id === args.canonicalTfmId)
  if (!canonical) {
    // Race: canonical was deleted between the caller's read and ours.
    // Surface as empty so the caller can short-circuit gracefully.
    return []
  }
  const canonicalSig = sourceSignature(canonical.mapping_sources ?? [])
  return candidates
    .filter((c) =>
      signaturesEqual(canonicalSig, sourceSignature(c.mapping_sources ?? [])),
    )
    .map((c) => ({ id: c.id, status: c.status }))
}
