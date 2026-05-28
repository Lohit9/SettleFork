/**
 * Build the rationale text for an "empty-slot" row in the Mapping First
 * view — an `unmapped-target` flat row with no TFM yet. PR Ω.3.7.5
 * introduced this as the fallback when the bare "—" placeholder would
 * otherwise render.
 *
 *   Tier 1 — `fields.description` (loader-populated; in Rootstock this
 *            is a `Field type: …, Required|Optional. <body>` sentence
 *            authored by scripts/rootstock-descriptions.ts).
 *   Tier 2 — `<data_type>, <Required|Optional>` synthesized from the
 *            field's schema metadata. `dataType` is typed `string` and
 *            defaults to 'unknown' on the wire (see the assembler at
 *            lib/ai/mapping-engine.ts), so tier 2 is always populated.
 *
 * Tier 3 ("—") is implicit at the call site: `formatEmptySlotRationale`
 * is invoked only for `unmapped-target` rows; other row kinds with
 * nothing to surface continue to render the gray em-dash.
 *
 * Suffix — always `· Not mapped`. PR Ω.3.8 collapsed empty-slot rows
 * from one-per-partition to one-per-target_field, so the row no longer
 * corresponds to a single partition; the prior `in <partition_label>`
 * suffix was dropped (it would have shown only the canonical partition,
 * misrepresenting a row that spans the full unmapped set).
 *
 * Pure: no React, no DOM. The caller wraps the return string in
 * `<span className="text-slate-500 italic">` so the metadata fallback
 * is visually distinct from real AI rationale on mapped rows.
 */
export function formatEmptySlotRationale(args: {
  description: string | null
  dataType: string
  isNullable: boolean
}): string {
  const description = args.description?.trim()
  const tier = description
    ? description
    : `${args.dataType}, ${args.isNullable ? 'Optional' : 'Required'}`
  return `${tier} · Not mapped`
}
