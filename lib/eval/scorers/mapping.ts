/**
 * Phase 1 PR 10.2 — mapping field-pair F1 scorer.
 *
 * The headline IC measurement (Phase 1 investigation §3.1, §7). Treats
 * each `(source_field_id, target_field_id)` tuple as a unit and
 * computes precision/recall/F1 over the bag.
 *
 * Pure: takes two arrays, returns a structured score. No I/O, no DB,
 * no LLM calls. Deterministic. Safe to call from any context.
 *
 * Combination-type fidelity, many-to-one collapse, and confidence
 * calibration are separate scorers (PR 11). This scorer ignores
 * `combination_type`, `contributing_source_field_ids`, `confidence`,
 * and `reasoning` — it answers exactly one question:
 *
 *     "Did the AI link the right source fields to the right target fields?"
 *
 * Used by the runner (PR 10.4) which wraps the return value into a
 * `ScoreResult` with example/scorer metadata.
 */

// ─── Public input/output shapes ───────────────────────────────────────────────

/**
 * What an AI mapping proposal looks like at scoring time. Mirrors the
 * shape `runMappingGenerationForPair` produces (modulo additional
 * metadata fields the scorer doesn't consume).
 */
export type ProposedMapping = {
  source_field_id: string
  target_field_id: string
  combination_type?: 'single' | 'concat_space' | 'concat_comma' | 'custom_sql'
  contributing_source_field_ids?: string[]
  confidence?: number
  reasoning?: string
}

/** Gold labels share the proposal shape — the scorer pulls only the field-pair. */
export type GoldMapping = ProposedMapping

/**
 * Per-example detail object. Lives inside `ScoreResult.details`.
 * The reconstructed tuple arrays let consumers (CI report, debug
 * tooling) show "what the AI missed / hallucinated" without needing
 * to re-derive from the input arrays.
 */
export type FieldPairScoreDetails = {
  precision: number
  recall: number
  f1: number
  matched: number
  missed: number
  extra: number
  matchedTuples: Array<{ source_field_id: string; target_field_id: string }>
  missedTuples: Array<{ source_field_id: string; target_field_id: string }>
  extraTuples: Array<{ source_field_id: string; target_field_id: string }>
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const SEP = '::'

function toKey(m: { source_field_id: string; target_field_id: string }): string {
  return `${m.source_field_id}${SEP}${m.target_field_id}`
}

function fromKey(key: string): { source_field_id: string; target_field_id: string } {
  // Tolerates source ids that contain `::` by splitting only on the FIRST
  // occurrence (target_field_id can't reasonably contain it; UUIDs don't,
  // and even free-form field names won't have `::`).
  const idx = key.indexOf(SEP)
  return {
    source_field_id: key.slice(0, idx),
    target_field_id: key.slice(idx + SEP.length),
  }
}

// ─── Public scorer ────────────────────────────────────────────────────────────

/**
 * Field-pair F1 scorer.
 *
 * Edge-case decision (documented per the PR 10.2 spec §3):
 * when BOTH `proposed` and `gold` are empty, score is **1.0** —
 * "nothing to map and we proposed nothing" is correct behavior.
 * The AI shouldn't be punished for an empty case.
 *
 * Other edge cases:
 *   - Empty `proposed`, non-empty `gold` → recall 0 → F1 0
 *   - Non-empty `proposed`, empty `gold` → precision 0 → F1 0
 *   - Duplicate tuples in either side → de-duplicated by Set; counted once
 *   - Tuples differ only by combination_type → both are `(a, x)` for
 *     field-pair purposes; this scorer treats them as a match
 */
export function scoreMappingFieldPair(
  proposed: ProposedMapping[],
  gold: GoldMapping[],
): { score: number; details: FieldPairScoreDetails } {
  const proposedKeys = new Set<string>(proposed.map(toKey))
  const goldKeys = new Set<string>(gold.map(toKey))

  const matchedKeys: string[] = []
  const missedKeys: string[] = []
  const extraKeys: string[] = []

  for (const k of goldKeys) {
    if (proposedKeys.has(k)) matchedKeys.push(k)
    else missedKeys.push(k)
  }
  for (const k of proposedKeys) {
    if (!goldKeys.has(k)) extraKeys.push(k)
  }

  const matched = matchedKeys.length
  const missed = missedKeys.length
  const extra = extraKeys.length

  const precDenom = matched + extra
  const recDenom = matched + missed

  const precision = precDenom === 0 ? 0 : matched / precDenom
  const recall = recDenom === 0 ? 0 : matched / recDenom
  const f1Denom = precision + recall
  const f1 = f1Denom === 0 ? 0 : (2 * precision * recall) / f1Denom

  // Both-empty short-circuit: "nothing to map, nothing proposed" is
  // a perfect prediction. We only get here when both Sets are empty,
  // which means precDenom === recDenom === 0; the math above produces
  // f1 = 0, but the semantic answer is 1.0.
  const bothEmpty = goldKeys.size === 0 && proposedKeys.size === 0
  const score = bothEmpty ? 1 : f1

  return {
    score,
    details: {
      precision: bothEmpty ? 1 : precision,
      recall: bothEmpty ? 1 : recall,
      f1: bothEmpty ? 1 : f1,
      matched,
      missed,
      extra,
      matchedTuples: matchedKeys.map(fromKey),
      missedTuples: missedKeys.map(fromKey),
      extraTuples: extraKeys.map(fromKey),
    },
  }
}
