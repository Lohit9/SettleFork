// PR 1 STOP 2 — Prompt smoke check.
// Builds a representative `generateTransform` user message against Test
// #7's real project data and asserts the 4 new blocks are present in
// the correct order with POC last. Does NOT make an LLM call.
//
// Run with: node --env-file=.env.local scripts/smoke-transform-prompt.mjs

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)
const TEST_7 = '0f2a95bb-1e80-4a8b-8e59-ae5559277730'

// Bundler-free reproductions of the helpers we need. Keeping a sibling
// import out of the .mjs entry point avoids the Next.js / TS toolchain
// dependency just for a smoke check. The actual production helpers are
// pinned by the snapshot tests in tests/actions/transformations-context.test.ts.
function fmtIntent(intent) {
  if (!intent || !intent.trim()) return ''
  return `<transformation_intent>\n${intent.trim()}\n</transformation_intent>`
}

function fmtPoc(key) {
  if (!key) return ''
  return `<poc_answer_key authoritative="true">
The following project-specific answer key takes precedence over general
guidance in the system prompt and any earlier document blocks. Generate
mapping output (target_field_mappings, mapping_sources, project_decisions,
project_lookup_tables, project_data_quality_issues, target_field_coverage,
project_inferred_targets, project_notes) matching this specification.

${key}
</poc_answer_key>`
}

function fmtLookups(rows) {
  if (!rows || rows.length === 0) return ''
  const entries = rows.map((t) => {
    const desc = t.description ? `\n  <description>${t.description}</description>` : ''
    const m = JSON.stringify(t.mappings, null, 2)
    return `<lookup_table id="${t.id}" name="${t.name}" customer_approved="${t.customer_approved}">${desc}
  <mappings>${m}</mappings>
</lookup_table>`
  })
  return `<lookup_tables>
(preamble omitted in smoke check; production helper emits the full text)

${entries.join('\n\n')}
</lookup_tables>`
}

function fmtDecisions(rows) {
  if (!rows || rows.length === 0) return ''
  const entries = rows.map((d) => {
    const desc = d.description ? `\n  <description>${d.description}</description>` : ''
    const cd =
      d.customer_decision != null
        ? `\n  <customer_decision>${JSON.stringify(d.customer_decision)}</customer_decision>`
        : ''
    return `<decision id="${d.id}" type="${d.decision_type}" status="${d.status}">
  <title>${d.title}</title>${desc}
  <ai_recommendation>${JSON.stringify(d.ai_recommendation)}</ai_recommendation>${cd}
</decision>`
  })
  return `<project_decisions>
(preamble omitted in smoke check; production helper emits the full text)

${entries.join('\n\n')}
</project_decisions>`
}

// ─── Fetch real data ──────────────────────────────────────────────────────────

const { data: lookupTables } = await supabase
  .from('project_lookup_tables')
  .select('id, name, description, mappings, applies_to_fields, data_quality_notes, customer_approved')
  .eq('project_id', TEST_7)
  .order('created_at', { ascending: true })

const { data: decisions } = await supabase
  .from('project_decisions')
  .select('id, decision_type, title, description, ai_recommendation, alternatives, customer_decision, applies_to, status')
  .eq('project_id', TEST_7)
  .order('created_at', { ascending: true })

const { data: pocDoc } = await supabase
  .from('schema_documents')
  .select('extracted_text')
  .eq('project_id', TEST_7)
  .eq('doc_type', 'poc_answer_key')
  .maybeSingle()

const { data: tfm } = await supabase
  .from('target_field_mappings')
  .select('id, transformation_intent, ai_reasoning')
  .eq('project_id', TEST_7)
  .not('transformation_intent', 'is', null)
  .limit(1)
  .single()

console.log('Pulled Test #7 data:')
console.log('  lookup_tables:', lookupTables?.length ?? 0)
console.log('  decisions:    ', decisions?.length ?? 0)
console.log('  poc_doc:      ', pocDoc?.extracted_text ? `${pocDoc.extracted_text.length} chars` : 'none')
console.log('  sample TFM:   ', tfm?.id, '\n')

// ─── Assemble representative user message ────────────────────────────────────

const lookupTablesBlock = fmtLookups(lookupTables ?? [])
const projectDecisionsBlock = fmtDecisions(decisions ?? [])
const transformationIntentBlock = fmtIntent(tfm?.transformation_intent ?? null)
const pocBlock = fmtPoc(pocDoc?.extracted_text ?? null)

// Stub field-scoped blocks — these come from production helpers
// (formatFieldForPrompt, formatDocumentsForPrompt) which are unchanged.
const sourceBlock = '<source_field>\n[stub] ProductUnitsName (text) [nullable, semantic:enum]\nTable: products\n</source_field>'
const targetField = 'rstk__peitem_enguom__r_external_id'
const targetTable = 'rstk__peitem'
const documentationBlock = '\n<documentation>\n[stub] business_context + schema_documentation here.\n</documentation>\n'

const userMessage = `${sourceBlock}

<target_field>
Field: ${targetTable}.${targetField}
Type: VARCHAR(40) (external_id)
Nullable: false
</target_field>

<type_compatibility>
String → External ID via lookup
</type_compatibility>
${lookupTablesBlock ? '\n' + lookupTablesBlock + '\n' : ''}${projectDecisionsBlock ? '\n' + projectDecisionsBlock + '\n' : ''}${documentationBlock}
${transformationIntentBlock ? transformationIntentBlock + '\n\n' : ''}<description>
Map ProductUnitsName via T-UOM-1 lookup
</description>
${pocBlock ? '\n' + pocBlock + '\n' : ''}
Generate the SQL transformation expression.`

// ─── Assertions ──────────────────────────────────────────────────────────────

const positions = {
  source: userMessage.indexOf('<source_field>'),
  target: userMessage.indexOf('<target_field>'),
  typeCompat: userMessage.indexOf('<type_compatibility>'),
  lookup: userMessage.indexOf('\n<lookup_tables>\n'),
  decisions: userMessage.indexOf('\n<project_decisions>\n'),
  docs: userMessage.indexOf('\n<documentation>\n'),
  intent: userMessage.indexOf('\n<transformation_intent>\n'),
  description: userMessage.indexOf('\n<description>\n'),
  poc: userMessage.indexOf('\n<poc_answer_key authoritative="true">\n'),
  task: userMessage.indexOf('Generate the SQL transformation expression.'),
}

const order = Object.entries(positions).sort((a, b) => a[1] - b[1])
console.log('Block positions (in order):')
for (const [k, v] of order) {
  console.log(`  ${String(k).padEnd(12)} @ char ${v}`)
}

const checks = [
  ['source < target', positions.source < positions.target],
  ['target < typeCompat', positions.target < positions.typeCompat],
  ['typeCompat < lookup', positions.typeCompat < positions.lookup],
  ['lookup < decisions', positions.lookup < positions.decisions],
  ['decisions < docs', positions.decisions < positions.docs],
  ['docs < intent', positions.docs < positions.intent],
  ['intent < description', positions.intent < positions.description],
  ['description < poc', positions.description < positions.poc],
  ['poc < task', positions.poc < positions.task],
  ['POC present', positions.poc >= 0],
  ['Lookup tables present', positions.lookup >= 0],
  ['Decisions present', positions.decisions >= 0],
  ['Intent present', positions.intent >= 0],
]

console.log('\nOrder + presence checks:')
let allOk = true
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'}  ${name}`)
  if (!ok) allOk = false
}

const chars = userMessage.length
// Rough token estimate: ~4 chars per token (Anthropic's order of magnitude).
// Add the ~5K-token TRANSFORM_SYSTEM_PROMPT for total input estimate.
const approxUserTokens = Math.round(chars / 4)
const approxTotalInputTokens = approxUserTokens + 5000

console.log('\nToken budget estimate:')
console.log(`  user message chars: ${chars.toLocaleString()}`)
console.log(`  user message tokens (chars/4): ~${approxUserTokens.toLocaleString()}`)
console.log(`  + system prompt (~5K): ~${approxTotalInputTokens.toLocaleString()} total input tokens`)
console.log(`  expected range: 22,000–27,000 input tokens`)
console.log(
  `  ${approxTotalInputTokens >= 18000 && approxTotalInputTokens <= 30000 ? '✓' : '✗'}  in expected range`,
)

console.log('\n' + (allOk ? '✓ SMOKE CHECK PASSED' : '✗ SMOKE CHECK FAILED'))
process.exit(allOk ? 0 : 1)
