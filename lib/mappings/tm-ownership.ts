/**
 * Pure ownership algorithm used by `deleteTableMapping`.
 *
 * Lives in its own module (not inside `lib/actions/mappings.ts`) so the
 * logic can be unit-tested without pulling in the server-action bundle,
 * Supabase clients, or Next.js runtime helpers.
 *
 * Ownership rules (kept in sync with the shim in `lib/compat/mapping-shim.ts`):
 *
 *   ▸ Mapped TFM (combination_type != 'custom_sql')
 *       A TM (source_table_id=S, target_table_id=T) owns this TFM iff the
 *       TFM's target_field is in T AND at least one mapping_source of the
 *       TFM has source_table_id=S.
 *
 *   ▸ VA TFM (combination_type = 'custom_sql', zero mapping_sources)
 *       A TM (S,T) owns the VA iff the VA's target_field is in T.
 *       Every TM targeting T co-owns VAs in T.
 *
 * The helper assumes its caller has already narrowed `candidateTfms` to
 * TFMs whose target_field lives in `targetTm.target_table_id` — i.e. every
 * candidate is a potential child of the TM being deleted.
 */

export type DeleteTmTargetTmInput = {
  source_table_id: string
  target_table_id: string
}

export type DeleteTmSiblingTmInput = {
  id: string
  source_table_id: string
  target_table_id: string
}

export type DeleteTmCandidateTfmInput = {
  id: string
  combination_type: string | null
}

export type ComputeOrphanedTfmsInput = {
  targetTm: DeleteTmTargetTmInput
  siblingTms: ReadonlyArray<DeleteTmSiblingTmInput>
  candidateTfms: ReadonlyArray<DeleteTmCandidateTfmInput>
  sourcesByTfm: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Given the TM being deleted plus every sibling TM in the same project,
 * return the ids of TFMs that would be left with no owner and therefore
 * must be cascade-deleted. Pure function — safe to call in a test context.
 */
export function computeOrphanedTfmsForTmDelete(input: ComputeOrphanedTfmsInput): string[] {
  const { targetTm, siblingTms, candidateTfms, sourcesByTfm } = input

  const siblingPairs = new Set<string>(
    siblingTms.map((s) => `${s.source_table_id}::${s.target_table_id}`),
  )
  const siblingTargets = new Set<string>(siblingTms.map((s) => s.target_table_id))

  const orphaned: string[] = []
  for (const cand of candidateTfms) {
    if (cand.combination_type === 'custom_sql') {
      if (!siblingTargets.has(targetTm.target_table_id)) {
        orphaned.push(cand.id)
      }
      continue
    }
    const sources = sourcesByTfm.get(cand.id) ?? new Set<string>()
    if (!sources.has(targetTm.source_table_id)) {
      continue
    }
    let ownedBySibling = false
    for (const srcTableId of sources) {
      if (siblingPairs.has(`${srcTableId}::${targetTm.target_table_id}`)) {
        ownedBySibling = true
        break
      }
    }
    if (!ownedBySibling) orphaned.push(cand.id)
  }
  return orphaned
}
