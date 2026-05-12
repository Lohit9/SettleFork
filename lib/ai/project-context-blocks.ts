// ─── Project-scoped context block formatters ──────────────────────────────────
//
// Emits three XML blocks for inclusion in agent user messages:
//   <lookup_tables>            — project_lookup_tables rows (Path D output)
//   <project_decisions>        — project_decisions rows (Path D output)
//   <transformation_intent>    — per-TFM intent text resolved from
//                                target_field_mappings.transformation_intent
//                                (falls back to ai_reasoning's [Combination: …]
//                                segment via resolveTransformationIntent).
//
// All three return '' when the source data is empty, so callers can
// unconditionally concatenate the result into a user message.
//
// Types are local to this module — these formatters are project-scoped,
// not Transform-specific, and may be lifted to lib/types/ in a future PR
// if validation or migration packaging consumers need them. Per PR 1 STOP 1,
// we keep them local to avoid contention with B's PR 3b territory.

export interface ProjectDecisionRow {
  id: string
  decision_type: string
  title: string
  description: string | null
  ai_recommendation: unknown
  alternatives: unknown
  customer_decision: unknown
  applies_to: unknown
  status: 'pending' | 'decided' | 'auto_applied'
}

export interface ProjectLookupTableRow {
  id: string
  name: string
  description: string | null
  /**
   * In production data this is either:
   *   - an object dict ({source_value: target_value}), or
   *   - a string describing a runtime computation rule
   *     (e.g. "Compute at transform time: SELECT DISTINCT ON ...").
   * We pass it through verbatim — the agent reads either form.
   */
  mappings: unknown
  applies_to_fields: unknown
  data_quality_notes: unknown
  customer_approved: boolean
}

// ─── formatLookupTablesBlock ──────────────────────────────────────────────────

export function formatLookupTablesBlock(tables: ProjectLookupTableRow[]): string {
  if (!tables || tables.length === 0) return ''

  const entries = tables.map((t) => {
    const mappingsJson = JSON.stringify(t.mappings, null, 2)
    const desc = t.description ? `\n  <description>${escapeXml(t.description)}</description>` : ''
    const appliesTo =
      t.applies_to_fields != null && !isEmptyJson(t.applies_to_fields)
        ? `\n  <applies_to_fields>${JSON.stringify(t.applies_to_fields)}</applies_to_fields>`
        : ''
    const dqNotes =
      t.data_quality_notes != null && !isEmptyJson(t.data_quality_notes)
        ? `\n  <data_quality_notes>${JSON.stringify(t.data_quality_notes)}</data_quality_notes>`
        : ''
    return `<lookup_table id="${t.id}" name="${escapeXml(t.name)}" customer_approved="${t.customer_approved}">${desc}
  <mappings>${mappingsJson}</mappings>${appliesTo}${dqNotes}
</lookup_table>`
  })

  return `<lookup_tables>
The following lookup / code-mapping tables have been defined for this project
by the upstream mapping pass. Each table's <mappings> is the literal
source→target value dictionary (object form) OR a free-text rule describing
a runtime computation (string form). When the per-TFM <transformation_intent>
or <description> refers to a value mapping (UOM normalization, status codes,
ICC group expansion, etc.), check whether one of these tables covers it
before inventing a CASE expression. Use the listed mappings verbatim — do
not paraphrase or add unlisted entries.

${entries.join('\n\n')}
</lookup_tables>`
}

// ─── formatProjectDecisionsBlock ──────────────────────────────────────────────

export function formatProjectDecisionsBlock(decisions: ProjectDecisionRow[]): string {
  if (!decisions || decisions.length === 0) return ''

  const entries = decisions.map((d) => {
    const desc = d.description ? `\n  <description>${escapeXml(d.description)}</description>` : ''
    const ai = `\n  <ai_recommendation>${JSON.stringify(d.ai_recommendation, null, 2)}</ai_recommendation>`
    const alts =
      d.alternatives != null && !isEmptyJson(d.alternatives)
        ? `\n  <alternatives>${JSON.stringify(d.alternatives)}</alternatives>`
        : ''
    const customer =
      d.customer_decision != null && !isEmptyJson(d.customer_decision)
        ? `\n  <customer_decision>${JSON.stringify(d.customer_decision, null, 2)}</customer_decision>`
        : ''
    const applies =
      d.applies_to != null && !isEmptyJson(d.applies_to)
        ? `\n  <applies_to>${JSON.stringify(d.applies_to)}</applies_to>`
        : ''
    return `<decision id="${d.id}" type="${escapeXml(d.decision_type)}" status="${d.status}">
  <title>${escapeXml(d.title)}</title>${desc}${ai}${alts}${customer}${applies}
</decision>`
  })

  return `<project_decisions>
The following business decisions have been recorded for this project. When a
decision has a non-null <customer_decision> (status=decided or auto_applied),
treat that resolved outcome as authoritative for any transformation it
applies to. When status=pending, treat <ai_recommendation> as a strong
default unless the per-TFM <transformation_intent> or <description>
contradicts it.

${entries.join('\n\n')}
</project_decisions>`
}

// ─── formatTransformationIntentBlock ──────────────────────────────────────────

export function formatTransformationIntentBlock(intent: string | null | undefined): string {
  if (!intent || !intent.trim()) return ''
  return `<transformation_intent>
${intent.trim()}
</transformation_intent>`
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isEmptyJson(value: unknown): boolean {
  if (value == null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  if (typeof value === 'string') return value.trim().length === 0
  return false
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
