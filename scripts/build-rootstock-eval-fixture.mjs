/**
 * Build the `rootstock-baseline` eval dataset from the Rootstock POC answer key.
 *
 * Source of truth: scripts/data/rootstock-answer-key.json (the v12 Excel
 * Mappings tab, machine-readable, scoped to project eba53ac1). Schema is
 * pulled live from the DB so types/nullability/PK/FK are real.
 *
 * Emits tests/eval/datasets/rootstock-baseline/{metadata,schema}.json +
 * examples/mapping/<pair>.json (one example per real source→target table
 * pair; gold = the real field-pair mappings the field-pair F1 scorer reads).
 * Value-assignments (Unmapped→target) and non-migrated (source→Unmapped) are
 * recorded in each example's metadata.notes but are NOT field-pair gold.
 *
 * Regenerate: node scripts/build-rootstock-eval-fixture.mjs
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ID = 'eba53ac1-3d35-45ba-852d-a3fa3761850b'
const OUT = join(ROOT, 'tests/eval/datasets/rootstock-baseline')

// ── env ───────────────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
    }),
)
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// ── pull live schema (source + target tables/fields) ────────────────────────────
const { data: datasets } = await supabase
  .from('datasets').select('id, role').eq('project_id', PROJECT_ID).in('role', ['source', 'target'])
const roleByDs = new Map(datasets.map((d) => [d.id, d.role]))
const { data: tables } = await supabase
  .from('tables').select('id, name, dataset_id').in('dataset_id', datasets.map((d) => d.id))
const tableMeta = new Map(tables.map((t) => [t.id, { name: t.name, role: roleByDs.get(t.dataset_id) }]))
const { data: fields } = await supabase
  .from('fields')
  .select('table_id, name, data_type, inferred_type, is_nullable, is_primary_key, is_foreign_key, ordinal_position')
  .in('table_id', tables.map((t) => t.id))
  .order('ordinal_position', { ascending: true })

const cleanType = (f) => {
  const dt = (f.data_type || '').split("'")[0].trim() // strip a malformed inferred-type tail
  return dt || f.inferred_type || 'text'
}
const schema = { source: { tables: [] }, target: { tables: [] } }
const byTable = new Map()
for (const f of fields) {
  const t = tableMeta.get(f.table_id)
  if (!t) continue
  if (!byTable.has(f.table_id))
    byTable.set(f.table_id, { name: t.name, role: t.role, fields: [] })
  byTable.get(f.table_id).fields.push({
    name: f.name,
    data_type: cleanType(f),
    is_nullable: f.is_nullable ?? true,
    ...(f.is_primary_key ? { is_primary_key: true } : {}),
    ...(f.is_foreign_key ? { is_foreign_key: true } : {}),
  })
}
for (const t of byTable.values()) schema[t.role].tables.push({ name: t.name, fields: t.fields })

// ── load answer key, split real pairs vs VA/unmapped ────────────────────────────
const key = JSON.parse(readFileSync(join(ROOT, 'scripts/data/rootstock-answer-key.json'), 'utf8'))[0]
const real = key.entries.filter((e) => e.source_table !== 'Unmapped' && e.target_table !== 'Unmapped')
const valueAssignments = key.entries.filter((e) => e.source_table === 'Unmapped' && e.target_table !== 'Unmapped')
const notMigrated = key.entries.filter((e) => e.target_table === 'Unmapped' && e.source_table !== 'Unmapped')

const comboType = (entry, sourcesForTarget) => {
  if (sourcesForTarget <= 1) return 'single'
  const t = JSON.stringify(entry.transformations ?? '').toLowerCase()
  if (t.includes('comma')) return 'concat_comma'
  if (t.includes('concat') || t.includes('space') || t.includes('combine')) return 'concat_space'
  return 'custom_sql'
}

const pairs = new Map()
for (const e of real) {
  const k = `${e.source_table}::${e.target_table}`
  if (!pairs.has(k)) pairs.set(k, [])
  pairs.get(k).push(e)
}

// ── write dataset ───────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'examples/mapping'), { recursive: true })

writeFileSync(join(OUT, 'metadata.json'), JSON.stringify({
  name: 'rootstock-baseline',
  description: 'Rootstock POC ground-truth (RCB Industries, Prosys→Rootstock). Field-pair gold from the v12 answer key; project eba53ac1. Value-assignments and non-migrated fields are recorded per-example but are not field-pair gold.',
  version: 'v12',
  author: 'alex',
  updatedAt: '2026-06-01',
}, null, 2) + '\n')

writeFileSync(join(OUT, 'schema.json'), JSON.stringify(schema, null, 2) + '\n')

let idx = 0
const manifest = []
for (const [k, entries] of pairs) {
  idx++
  const [sourceTable, targetTable] = k.split('::')
  const srcCountByTarget = entries.reduce((m, e) => m.set(e.target_field, (m.get(e.target_field) || 0) + 1), new Map())
  const mappings = entries.map((e) => ({
    source_field: e.source_field,
    target_field: e.target_field,
    combination_type: comboType(e, srcCountByTarget.get(e.target_field)),
  }))
  const slug = `${String(idx).padStart(3, '0')}-${k.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
  const vaForTarget = valueAssignments.filter((e) => e.target_table === targetTable).length
  const example = {
    id: `rootstock-baseline/mapping/${slug}`,
    task: 'mapping',
    input: { source_table: sourceTable, target_table: targetTable },
    gold: { mappings },
    metadata: {
      author: 'alex',
      difficulty: 'hard',
      notes: `Field-pair gold = ${mappings.length} real source→target mappings for ${sourceTable} → ${targetTable}. The answer key also records ${vaForTarget} value-assignments (no source) on ${targetTable} and ${notMigrated.filter((e) => e.source_table === sourceTable).length} non-migrated ${sourceTable} fields — not field-pair gold (the field-pair scorer only scores source→target links).`,
    },
  }
  writeFileSync(join(OUT, 'examples/mapping', `${slug}.json`), JSON.stringify(example, null, 2) + '\n')
  manifest.push(`${slug}: ${mappings.length} gold pairs`)
}

console.log('schema:', schema.source.tables.length, 'source tables,', schema.target.tables.length, 'target tables')
console.log('examples:', manifest.length)
manifest.forEach((m) => console.log('  ', m))
console.log('value-assignments (context, not gold):', valueAssignments.length, '| non-migrated:', notMigrated.length)
console.log('written to', OUT)
