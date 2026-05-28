/**
 * Build the rationale text for an "empty-slot" row in the Mapping First
 * view — an `unmapped-target` flat row where `(target_field × partition)`
 * has no TFM yet. PR Ω.3.7.5 replaces the bare "—" placeholder with a
 * two-tier fallback so the column carries real schema signal even
 * before any AI mapping has been authored.
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
 * Suffix — appends `· Not mapped in <partition_label>` for partitioned
 *          projects, or `· Not mapped` for heritage (single-partition,
 *          null label) projects. Mirrors the partition copy used in the
 *          drawer header.
 *
 * Pure: no React, no DOM. The caller wraps the return string in
 * `<span className="text-slate-500 italic">` so the metadata fallback
 * is visually distinct from real AI rationale on mapped rows.
 */
export function formatEmptySlotRationale(args: {
  description: string | null
  dataType: string
  isNullable: boolean
  partitionLabel: string | null | undefined
}): string {
  const description = args.description?.trim()
  const tier = description
    ? description
    : `${args.dataType}, ${args.isNullable ? 'Optional' : 'Required'}`
  const suffix = args.partitionLabel
    ? ` · Not mapped in ${args.partitionLabel}`
    : ' · Not mapped'
  return `${tier}${suffix}`
}
