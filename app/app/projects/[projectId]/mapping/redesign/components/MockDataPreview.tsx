'use client'

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code,
  Cpu,
  Filter,
  Info,
  Layers,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sparkles,
  Table2,
  Trash2,
  User,
  Wrench,
  X,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// MOCK — Settle MVP "Data Preview" surface (the design's `target` lens,
// ReadyToLoadView + the Rtl* tree from src/screen-configure.jsx). Hardcoded
// design data so the Data Preview tab matches the reference ahead of real data
// wiring. Column-open is a visual-only selection (no real drawer); regenerate,
// review-pill filtering, partition collapse, sort/filter menus, and pagination
// are all local mock state. The underlying mappings/values are never persisted.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ──────────────────────────────────────────────────────────────────

type Severity = 'blocking' | 'warning'

interface DerivSpec {
  deriv: string
  conf: number
  srcTable: string
  srcField: string
  expr: string
  explain: string
}

interface ColumnMeta {
  key: string
  type: string
}

interface ColIssue {
  kind: 'blocking' | 'warning'
  text: string
  records: number
}

interface TableMeta {
  columns: ColumnMeta[]
  rows: string[][]
  colIssues: Record<string, ColIssue[]>
}

interface TableSummary {
  name: string
  rows: number
  fields: number
  issues: { kind: 'blocking' | 'warning'; count: number } | null
}

interface CellIssue {
  sev: Severity
  count: number
  rows: number[]
}

interface PartitionConfig {
  id: string
  name: string
  priority: number
  source: string
  filter: string
  excludes: string | null
  rows: number
  deduped: number
  deriv: Record<string, DerivSpec>
  data: string[][]
}

interface PartitionedTable {
  summary: { partitions: number; order: string; rows: number; deduped: number }
  columns: [string, string][]
  partitions: PartitionConfig[]
}

type SortDir = 'asc' | 'desc'
interface SortBy {
  key: string
  dir: SortDir
}

type ColumnFilter =
  | { kind: 'in'; values: string[] }
  | { kind: 'text'; query: string }
  | { kind: 'range'; min: string; max: string }

interface ReviewState {
  issues: boolean
  lowConf: boolean
  partition: boolean
}

interface RolledIssue {
  id: string
  kind: 'blocking' | 'warning'
  text: string
  records: number
  column: string
}

// ─── Mock data (verbatim from the design) ───────────────────────────────────

const DL_TABLES: TableSummary[] = [
  { name: 'Commodity Codes', rows: 210, fields: 5, issues: { kind: 'warning', count: 2 } },
  { name: 'Engineering Item Master', rows: 2079, fields: 5, issues: { kind: 'blocking', count: 19 } },
  { name: 'Bill of Materials', rows: 5400, fields: 6, issues: null },
  { name: 'Product', rows: 486, fields: 7, issues: { kind: 'blocking', count: 12 } },
  { name: 'Work Center', rows: 42, fields: 6, issues: null },
  { name: 'Routing', rows: 1820, fields: 6, issues: null },
  { name: 'Customer', rows: 328, fields: 9, issues: { kind: 'blocking', count: 7 } },
]

const COMMODITY_CODES_META: TableMeta = {
  columns: [
    { key: 'commodity_code', type: 'VARCHAR(20)' },
    { key: 'description', type: 'VARCHAR(100)' },
    { key: 'commodity_class', type: 'VARCHAR(40)' },
    { key: 'default_gl_account', type: 'VARCHAR(20)' },
    { key: 'is_active', type: 'BOOLEAN' },
  ],
  rows: [
    ['RCB-PRINT-SLEEVE', 'Printed Sleeves', 'Finished Goods', '4000-COGS', 'true'],
    ['RCB-PRINT-CUP', 'Printed Cups', 'Finished Goods', '4000-COGS', 'true'],
    ['RCB-CONSUMABLE-INK', 'Inks & Consumables', 'Raw Materials', '5100-MAT', 'true'],
    ['RCB-PRINT-MAT', 'Print Substrates', 'Raw Materials', '5100-MAT', 'true'],
    ['RCB-BLANK-CUP', 'Blank Cups', 'Finished Goods', '4000-COGS', 'true'],
    ['RCB-CONSUMABLE-GLUE', 'Adhesives', 'Raw Materials', '5100-MAT', 'true'],
    ['RCB-PRINT-LID', 'Printed Lids', 'Finished Goods', '4000-COGS', 'true'],
    ['RCB-PACK-CARTON', 'Shipping Cartons', 'Raw Materials', '5100-MAT', 'false'],
    ['RCB-MRO-PLATE', 'Press Plates', 'MRO', '6200-MRO', 'true'],
    ['RCB-PRINT-TRAY', 'Printed Trays', 'Finished Goods', '4000-COGS', 'true'],
    ['RCB-PACK-SHRINK', 'Shrink Wrap Film', 'Raw Materials', '5100-MAT', 'true'],
    ['RCB-CONSUMABLE-TONER', 'Digital Toner', 'Raw Materials', '5100-MAT', 'true'],
    ['RCB-MRO-BLANKET', 'Press Blankets', 'MRO', '6200-MRO', 'true'],
    ['RCB-PRINT-WRAP', 'Printed Wraps', 'Finished Goods', '4000-COGS', 'true'],
    ['RCB-PACK-LABEL', 'Shipping Labels', 'Raw Materials', '5100-MAT', 'false'],
  ],
  colIssues: {
    commodity_class: [{ kind: 'warning', text: '6 commodity classes could not be resolved via class_map', records: 6 }],
    default_gl_account: [{ kind: 'warning', text: '6 GL codes have no match in gl_map and load as NULL', records: 6 }],
  },
}

const TABLE_META: Record<string, TableMeta> = {
  'Commodity Codes': COMMODITY_CODES_META,
}

// Fallback columns for tables without an explicit meta — [key, type] pairs.
const FALLBACK_COLUMNS: Record<string, [string, string][]> = {
  'Bill of Materials': [
    ['bom_id', 'VARCHAR(40)'],
    ['parent_item', 'VARCHAR(50)'],
    ['component_item', 'VARCHAR(50)'],
    ['quantity_per', 'DECIMAL(12,4)'],
    ['unit_of_measure', 'VARCHAR(8)'],
    ['effectivity_date', 'DATE'],
  ],
  Product: [
    ['product_code', 'VARCHAR(40)'],
    ['product_name', 'VARCHAR(120)'],
    ['status', 'VARCHAR(20)'],
    ['list_price', 'DECIMAL(12,2)'],
    ['uom', 'VARCHAR(8)'],
    ['discontinued_date', 'DATE'],
    ['tax_id_type', 'VARCHAR(20)'],
  ],
  'Work Center': [
    ['work_center_code', 'VARCHAR(40)'],
    ['description', 'VARCHAR(100)'],
    ['cost_center', 'VARCHAR(20)'],
    ['capacity_hrs', 'DECIMAL(10,2)'],
    ['shift_count', 'INTEGER'],
    ['is_active', 'BOOLEAN'],
  ],
  Routing: [
    ['routing_id', 'VARCHAR(40)'],
    ['item_number', 'VARCHAR(50)'],
    ['operation_seq', 'INTEGER'],
    ['work_center_code', 'VARCHAR(40)'],
    ['std_batch_qty', 'DECIMAL(12,2)'],
    ['run_time_hrs', 'DECIMAL(10,2)'],
  ],
  Customer: [
    ['customer_id', 'VARCHAR(40)'],
    ['customer_name', 'VARCHAR(120)'],
    ['address_line1', 'VARCHAR(120)'],
    ['city', 'VARCHAR(60)'],
    ['region', 'VARCHAR(40)'],
    ['postal_code', 'VARCHAR(16)'],
    ['credit_hold', 'BOOLEAN'],
    ['tax_id_type', 'VARCHAR(20)'],
    ['sales_region', 'VARCHAR(40)'],
  ],
}

const READY_PARTITIONS: Record<string, PartitionedTable> = {
  'Engineering Item Master': {
    summary: { partitions: 2, order: 'UNION in priority order', rows: 2079, deduped: 23 },
    columns: [
      ['item_number', 'VARCHAR(50)'],
      ['item_description', 'VARCHAR(100)'],
      ['commodity_code', 'lookup'],
      ['inventory_source', 'picklist'],
      ['item_type', 'picklist'],
    ],
    partitions: [
      {
        id: 'A',
        name: 'Partition A',
        priority: 1,
        source: 'Engineering BOM Masters',
        filter: 'Assy Item IS NOT NULL',
        excludes: null,
        rows: 1247,
        deduped: 0,
        deriv: {
          item_number: { deriv: 'Assy Item', conf: 98, srcTable: 'BOM_MASTERS', srcField: 'ASSY_ITEM', expr: 'TRIM(UPPER("Assy Item"))', explain: 'Assembly item number maps directly to item_number, trimmed and upper-cased.' },
          item_description: { deriv: 'COALESCE(ProductName, Assy Desc)', conf: 84, srcTable: 'BOM_MASTERS', srcField: 'PRODUCT_NAME', expr: 'COALESCE("ProductName", "Assy Desc")', explain: 'Item description prefers ProductName, falling back to Assy Desc. The fallback path holds confidence below 90%.' },
          commodity_code: { deriv: 'derived → lookup', conf: 92, srcTable: 'BOM_MASTERS', srcField: 'COMM_HINT', expr: '(SELECT commodity_code FROM commodity cc WHERE cc.hint = b.COMM_HINT)', explain: 'Commodity code is derived from the item and resolved against Commodity Codes.' },
          inventory_source: { deriv: "'Manufactured' (const)", conf: 99, srcTable: 'BOM_MASTERS', srcField: '—', expr: "'Manufactured'", explain: 'Partition A items are manufactured; inventory source is set to a constant.' },
          item_type: { deriv: "'Direct Material' (const)", conf: 99, srcTable: 'BOM_MASTERS', srcField: '—', expr: "'Direct Material'", explain: 'Item type is set to a constant for this partition.' },
        },
        data: [
          ['P-DWS', 'Full Wrap Custom Printed White Sleeves', 'RCB-PRINT-SLEEVE', 'Manufactured', 'Direct Material'],
          ['P-WHC08', '8oz Custom Printed White Paper Hot Cups', 'RCB-PRINT-CUP', 'Manufactured', 'Direct Material'],
          ['WHC08', 'Blank 8oz White Paper Hot Cups', 'RCB-BLANK-CUP', 'Manufactured', 'Direct Material'],
        ],
      },
      {
        id: 'B',
        name: 'Partition B',
        priority: 2,
        source: 'Engineering BOM Masters',
        filter: 'Part # IS NOT NULL',
        excludes: 'Partition A',
        rows: 832,
        deduped: 23,
        deriv: {
          item_number: { deriv: 'Part #', conf: 97, srcTable: 'BOM_MASTERS', srcField: 'PART_NO', expr: 'TRIM("Part #")', explain: 'Part number maps directly to item_number.' },
          item_description: { deriv: 'Item', conf: 96, srcTable: 'BOM_MASTERS', srcField: 'ITEM', expr: 'TRIM("Item")', explain: 'Item text maps directly to item_description.' },
          commodity_code: { deriv: 'derived → lookup', conf: 79, srcTable: 'BOM_MASTERS', srcField: 'COMM_HINT', expr: '(SELECT commodity_code FROM commodity cc WHERE cc.hint = b.COMM_HINT)', explain: 'Commodity code is derived via lookup; several purchased-part hints are unresolved, lowering confidence.' },
          inventory_source: { deriv: "'Purchased' (const)", conf: 99, srcTable: 'BOM_MASTERS', srcField: '—', expr: "'Purchased'", explain: 'Partition B items are purchased; inventory source is set to a constant.' },
          item_type: { deriv: "'Direct Material' (const)", conf: 99, srcTable: 'BOM_MASTERS', srcField: '—', expr: "'Direct Material'", explain: 'Item type is set to a constant for this partition.' },
        },
        data: [
          ['PR-SBS-DWSP', 'Atlantic 16pt SBS, 23″x29″', 'RCB-PRINT-MAT', 'Purchased', 'Direct Material'],
          ['A0001', 'Process Cyan Ink', 'RCB-CONSUMABLE-INK', 'Purchased', 'Direct Material'],
          ['D0001', 'Cold-Seal Adhesive', 'RCB-CONSUMABLE-GLUE', 'Purchased', 'Direct Material'],
        ],
      },
    ],
  },
}

const READY_DERIV: Record<string, Record<string, DerivSpec>> = {
  'Commodity Codes': {
    commodity_code: { deriv: 'COMM_CD', conf: 99, srcTable: 'COMMODITY_MASTER', srcField: 'COMM_CD', expr: 'COMM_CD', explain: 'Commodity code is the natural key — direct pass-through, no transformation required.' },
    description: { deriv: 'COMM_DESC → trim', conf: 100, srcTable: 'COMMODITY_MASTER', srcField: 'COMM_DESC', expr: 'TRIM(COMM_DESC)', explain: 'Free-text description passes through with a trailing-whitespace trim.' },
    commodity_class: { deriv: 'CLASS_CD → lookup', conf: 86, srcTable: 'COMMODITY_MASTER', srcField: 'CLASS_CD', expr: '(SELECT class_name FROM class_map cm WHERE cm.code = c.CLASS_CD)', explain: 'Short class codes (FG, RM) resolve to full class names via class_map. A few legacy codes are unmapped, holding confidence below 90%.' },
    default_gl_account: { deriv: 'GL_ACCT → lookup', conf: 88, srcTable: 'COMMODITY_MASTER', srcField: 'GL_ACCT', expr: '(SELECT gl_account FROM gl_map g WHERE g.code = c.GL_ACCT)', explain: 'Abbreviated GL codes resolve to full Rootstock GL accounts via gl_map. Six codes have no match and load as NULL.' },
    is_active: { deriv: 'ACTIVE_FLG → boolean', conf: 98, srcTable: 'COMMODITY_MASTER', srcField: 'ACTIVE_FLG', expr: "CASE ACTIVE_FLG WHEN 'Y' THEN true ELSE false END", explain: 'Y/N source flag is cast to a boolean.' },
  },
}

// Column-level issue config for the single-partition grid. rows = data-row
// indices to tint at cell level.
const READY_ISSUES: Record<string, Record<string, CellIssue>> = {
  'Commodity Codes': {
    commodity_class: { sev: 'warning', count: 1, rows: [2, 3] },
    default_gl_account: { sev: 'blocking', count: 1, rows: [2, 3] },
  },
}

// ─── All-issues slide-over data ──────────────────────────────────────────────
// Per-table issue groups for the "Data quality issues" panel. Derived from the
// same data the grid already carries (DL_TABLES blocking counts, the column
// issue text in TABLE_META / READY_PARTITIONS deriv, sample record counts) and
// reshaped into the design's ISSUE_GROUPS structure. The FieldPill renders the
// fully-qualified `{table}.{field}` so a row reads end-to-end on its own.

interface PanelIssue {
  id: string
  field: string
  records: number
  root: string
  desc: string
}

interface IssueGroup {
  table: string
  status: string
  issues: PanelIssue[]
}

const ISSUE_GROUPS: IssueGroup[] = [
  {
    table: 'Engineering Item Master',
    status: 'Staged',
    issues: [
      { id: 'eim-commodity_code', field: 'Engineering Item Master.commodity_code', records: 41, root: 'Lookup miss', desc: 'Commodity code unresolved — no match in Commodity Codes' },
      { id: 'eim-item_description', field: 'Engineering Item Master.item_description', records: 23, root: 'Missing source', desc: 'ProductName and Assy Desc both null on deduped items' },
    ],
  },
  {
    table: 'Product',
    status: 'Staged',
    issues: [
      { id: 'product-status', field: 'Product.status', records: 18, root: 'Transform error', desc: 'Numeric status codes where enum expected (Active, Hold, Obsolete)' },
      { id: 'product-uom', field: 'Product.uom', records: 12, root: 'Missing transform', desc: 'Legacy UOM codes not in the Rootstock picklist' },
    ],
  },
  {
    table: 'Customer',
    status: 'Staged',
    issues: [
      { id: 'customer-address_line1', field: 'Customer.address_line1', records: 31, root: 'Missing transform', desc: 'Single field carries street, city, region, and postal code — split required' },
      { id: 'customer-tax_id_type', field: 'Customer.tax_id_type', records: 9, root: 'Missing transform', desc: 'Legacy tax-id type codes not in the Rootstock picklist' },
    ],
  },
  {
    table: 'Commodity Codes',
    status: 'Staged',
    issues: [
      { id: 'cc-default_gl_account', field: 'Commodity Codes.default_gl_account', records: 6, root: 'Lookup miss', desc: 'GL code has no match in gl_map reference table' },
    ],
  },
]

// ─── Drawer validation (derived from existing issue data, not new mock) ──────

interface RtlValidation {
  sev: Severity
  count: number
  heading: string
  values: string[]
}

// Resolve the drawer's validation block for a target field from the data the
// grid already carries: cell severity/count from READY_ISSUES, the human
// heading from the table meta's colIssues, and sample chips pulled from the
// flagged rows of the real data. No new mock content — same shapes the grid
// already renders, reshaped for the review unit.
function rtlValidationFor(table: string, field: string): RtlValidation | null {
  const cell = (READY_ISSUES[table] || {})[field]
  if (!cell) return null
  const meta = TABLE_META[table]
  const colIssue = meta && meta.colIssues[field] ? meta.colIssues[field][0] : null
  const heading = colIssue ? colIssue.text : `${field} flagged ${cell.count} issue${cell.count === 1 ? '' : 's'}`
  const values: string[] = []
  if (meta) {
    const idx = meta.columns.findIndex((c) => c.key === field)
    if (idx >= 0) {
      cell.rows.forEach((ri) => {
        const row = meta.rows[ri]
        if (row && row[idx] != null) values.push(String(row[idx]))
      })
    }
  }
  return { sev: cell.sev, count: colIssue ? colIssue.records : cell.count, heading, values }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rtlColumnsForTable(name: string): ColumnMeta[] {
  const part = READY_PARTITIONS[name]
  if (part) return part.columns.map(([key, type]) => ({ key, type }))
  const meta = TABLE_META[name]
  if (meta) return meta.columns
  const fb = FALLBACK_COLUMNS[name] || []
  return fb.slice(0, 8).map(([key, type]) => ({ key, type }))
}

function rtlDerivFor(table: string, colKey: string): DerivSpec {
  const t = READY_DERIV[table]
  if (t && t[colKey]) return t[colKey]
  return {
    deriv: colKey.toUpperCase(),
    conf: 97,
    srcTable: '—',
    srcField: colKey.toUpperCase(),
    expr: colKey.toUpperCase(),
    explain: 'Direct pass-through from the matched source field. No transformation required.',
  }
}

function rtlConfColor(conf: number): string {
  return conf >= 90 ? '#10B981' : '#F59E0B'
}

// Page list for numbered pagination: page 1, last page, a window around the
// current page, and "…" for collapsed gaps.
function rtlPageItems(cur: number, total: number): (number | '…')[] {
  if (total <= 1) return [1]
  const out: (number | '…')[] = [1]
  let start = Math.max(2, cur - 1)
  let end = Math.min(total - 1, cur + 1)
  if (cur <= 2) {
    start = 2
    end = Math.min(total - 1, 3)
  }
  if (cur >= total - 1) {
    start = Math.max(2, total - 2)
    end = total - 1
  }
  if (start > 2) out.push('…')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < total - 1) out.push('…')
  out.push(total)
  return out
}

function isNumericType(type: string): boolean {
  return /DECIMAL|INTEGER|NUMERIC|FLOAT|DOUBLE|BIGINT/i.test(type || '')
}

function distinctValuesFor(col: ColumnMeta, meta: TableMeta): { value: string; count: number }[] {
  const idx = (meta.columns || []).findIndex((c) => c.key === col.key)
  if (idx < 0 || !meta.rows || meta.rows.length === 0) return []
  const counts: Record<string, number> = {}
  meta.rows.forEach((r) => {
    const v = r[idx] == null ? '' : String(r[idx])
    counts[v] = (counts[v] || 0) + 1
  })
  return Object.entries(counts)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
}

function applyTableFilterSort(
  rows: string[][],
  columns: ColumnMeta[],
  filters: Record<string, ColumnFilter>,
  sortBy: SortBy | null,
): string[][] {
  let out = rows
  if (filters && Object.keys(filters).length) {
    for (const [colKey, f] of Object.entries(filters)) {
      const idx = columns.findIndex((c) => c.key === colKey)
      if (idx < 0 || !f) continue
      if (f.kind === 'in') {
        const set = new Set(f.values || [])
        out = out.filter((r) => set.has(String(r[idx])))
      } else if (f.kind === 'text') {
        const q = (f.query || '').toLowerCase()
        if (q) out = out.filter((r) => String(r[idx] == null ? '' : r[idx]).toLowerCase().includes(q))
      } else if (f.kind === 'range') {
        const min = f.min !== '' && f.min != null ? parseFloat(f.min) : null
        const max = f.max !== '' && f.max != null ? parseFloat(f.max) : null
        out = out.filter((r) => {
          const v = parseFloat(String(r[idx] == null ? '' : r[idx]).replace(/,/g, ''))
          if (Number.isNaN(v)) return false
          if (min != null && v < min) return false
          if (max != null && v > max) return false
          return true
        })
      }
    }
  }
  if (sortBy) {
    const idx = columns.findIndex((c) => c.key === sortBy.key)
    if (idx >= 0) {
      const dir = sortBy.dir === 'desc' ? -1 : 1
      out = [...out].sort((a, b) => {
        const av = a[idx]
        const bv = b[idx]
        const an = parseFloat(String(av).replace(/,/g, ''))
        const bn = parseFloat(String(bv).replace(/,/g, ''))
        if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * dir
        return String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv)) * dir
      })
    }
  }
  return out
}

function filterExpressionLabel(f: ColumnFilter): string {
  if (!f) return ''
  if (f.kind === 'in') return (f.values || []).join(', ')
  if (f.kind === 'text') return `contains "${f.query}"`
  if (f.kind === 'range') {
    const min = f.min != null && f.min !== '' ? f.min : ''
    const max = f.max != null && f.max !== '' ? f.max : ''
    if (min !== '' && max !== '') return `${min}–${max}`
    if (min !== '') return `≥ ${min}`
    if (max !== '') return `≤ ${max}`
  }
  return ''
}

// Rolled-up issue list used by the bottom data-quality summary: column-scope
// issues in column-declaration order, blocking before warning.
function rolledIssuesFor(tableName: string, meta: TableMeta): RolledIssue[] {
  const colOrder = (meta.columns || []).map((c) => c.key)
  const colIssuesAll: RolledIssue[] = Object.entries(meta.colIssues || {}).flatMap(([col, list]) =>
    list.map((i, idx) => ({ ...i, id: `c-${tableName}-${col}-${idx}`, column: col })),
  )
  colIssuesAll.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'blocking' ? -1 : 1
    return colOrder.indexOf(a.column) - colOrder.indexOf(b.column)
  })
  return colIssuesAll
}

// ─── Cell-level provenance ───────────────────────────────────────────────────

const RTL_CLASS_MAP_REV: Record<string, string> = {
  'Finished Goods': 'FG',
  'Raw Materials': 'RM',
  'Work In Process': 'WIP',
  MRO: 'MRO',
}
const RTL_GL_MAP_REV: Record<string, string> = { '4000-COGS': '4000', '6200-MRO': '6200' }

interface Provenance {
  srcField: string
  srcValue: string
  rule: string
  result: string | null
  resultNull?: boolean
  issue?: string
}

function rtlCellProvenance(
  table: string,
  colKey: string,
  value: string,
  spec: DerivSpec,
  flagged: Severity | null,
): Provenance {
  const sf = spec && spec.srcField ? spec.srcField : colKey.toUpperCase()
  if (table === 'Commodity Codes') {
    switch (colKey) {
      case 'commodity_code':
        return { srcField: 'COMM_CD', srcValue: value, rule: 'Pass-through (natural key)', result: value }
      case 'description':
        return { srcField: 'COMM_DESC', srcValue: value + '  ', rule: 'Trim trailing whitespace', result: value }
      case 'commodity_class': {
        const code = RTL_CLASS_MAP_REV[value] || value
        if (flagged)
          return { srcField: 'CLASS_CD', srcValue: code, rule: 'Lookup via class_map', result: value, issue: `"${code}" is a deprecated class_map code — defaulted to ${value}; verify mapping` }
        return { srcField: 'CLASS_CD', srcValue: code, rule: 'Lookup via class_map', result: value }
      }
      case 'default_gl_account': {
        if (flagged)
          return { srcField: 'GL_ACCT', srcValue: value, rule: 'Lookup via gl_map', result: null, resultNull: true, issue: `No gl_map entry for "${value}"` }
        const code = RTL_GL_MAP_REV[value] || value.split('-')[0]
        return { srcField: 'GL_ACCT', srcValue: code, rule: 'Lookup via gl_map', result: value }
      }
      case 'is_active':
        return { srcField: 'ACTIVE_FLG', srcValue: value === 'true' ? 'Y' : 'N', rule: 'Cast Y/N → boolean', result: value }
    }
  }
  const deriv = (spec && spec.deriv) || colKey.toUpperCase()
  const isConst = /\(const\)/.test(deriv)
  const isPass = !/[→(]/.test(deriv)
  let rule: string
  if (isConst) rule = 'Set constant'
  else if (isPass) rule = 'Pass-through (no transform)'
  else rule = deriv
  return { srcField: sf, srcValue: isConst ? '—' : value, rule, result: value }
}

function rtlProvVal(v: string | null): string {
  return v === '—' ? '—' : `"${v}"`
}

// ─── Column-focus / hover styling tokens ─────────────────────────────────────

const RTL_FOCUS_TINT = 'rgba(35, 88, 212, 0.05)'
const RTL_FOCUS_BAR = 'inset 0 3px 0 0 #2358D4'
const RTL_SELECT_BAR = 'inset 0 2px 0 0 #2358D4'
const RTL_HOVER_TINT = '#F9FAFB'

// ─── Status dot ──────────────────────────────────────────────────────────────

const DOT: Record<string, string> = {
  ok: '#10B981',
  warning: '#F59E0B',
  blocking: '#EF4444',
  neutral: '#9CA3AF',
}
function Dot({ kind = 'neutral', size = 6, className = '' }: { kind?: keyof typeof DOT; size?: number; className?: string }) {
  return <span className={`inline-block rounded-full align-middle ${className}`} style={{ width: size, height: size, background: DOT[kind] }} />
}

// ─── Review-status glyph (green ringed check / dashed hollow ring) ───────────

function ReviewGlyph({ reviewed, size = 14, className = '', title }: { reviewed: boolean; size?: number; className?: string; title?: string }) {
  if (reviewed) {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" className={className} role="img" aria-label={title || 'Reviewed'}>
        <title>{title || 'Reviewed'}</title>
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="#16A34A" strokeWidth="1.5" />
        <path d="M6.2 10.4 L8.7 12.9 L13.9 7.3" fill="none" stroke="#16A34A" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={className} role="img" aria-label={title || 'Needs review'}>
      <title>{title || 'Needs review'}</title>
      <circle cx="10" cy="10" r="8.25" fill="none" stroke="#C4C9D0" strokeWidth="1.5" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

// ─── Table picker ────────────────────────────────────────────────────────────

function TablePicker({
  tables,
  selected,
  onSelect,
  currentRows,
  reviewedTables,
}: {
  tables: TableSummary[]
  selected: string
  onSelect: (name: string) => void
  currentRows: number
  reviewedTables: Set<string>
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      clearTimeout(tid)
    }
  }, [open])
  useEffect(() => {
    if (!open) setQ('')
  }, [open])

  const qq = q.trim().toLowerCase()
  const visible = qq ? tables.filter((t) => t.name.toLowerCase().includes(qq)) : tables

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-[12.5px] hover:bg-[#F9FAFB]"
      >
        <Table2 className="h-3 w-3 text-[#6B7280]" />
        <span className="font-mono text-[12.5px] text-[#111827]">{selected}</span>
        <span className="text-[#9CA3AF] tabular-nums">· {currentRows.toLocaleString()} rows</span>
        <ChevronDown className="h-[11px] w-[11px] text-[#6B7280]" />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-30 flex w-[320px] flex-col overflow-hidden rounded-md border border-[#E5E7EB] bg-white shadow-[0_8px_24px_-6px_rgba(17,24,39,0.14)]" style={{ maxHeight: 380 }}>
          <div className="shrink-0 border-b border-[#E5E7EB] bg-white p-2">
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#9CA3AF]">
                <Search className="h-3.5 w-3.5" />
              </span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tables and fields..."
                className="w-full rounded-md border border-[#E5E7EB] bg-white py-1.5 pl-8 pr-3 text-[13px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
              />
            </div>
          </div>
          <div className="overflow-y-auto py-1">
            {visible.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-[#9CA3AF]">No tables match &ldquo;{q}&rdquo;.</div>
            )}
            {visible.map((t) => {
              const sel = t.name === selected
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => {
                    onSelect(t.name)
                    setOpen(false)
                  }}
                  className={`group relative flex w-full items-center gap-2 py-2 pl-3 pr-2 text-left ${sel ? 'bg-[#F3F4F6]' : 'hover:bg-[#F9FAFB]'}`}
                >
                  <span className="absolute bottom-1 left-0 top-1 w-[2px] rounded-r" style={{ background: sel ? '#2358D4' : 'transparent' }} />
                  <Table2 className={`h-3 w-3 ${sel ? 'text-[#111827]' : 'text-[#9CA3AF]'}`} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#111827]">{t.name}</span>
                  <span className="shrink-0 text-[10.5px] tabular-nums text-[#9CA3AF]">{t.rows.toLocaleString()}</span>
                  {t.issues && (
                    <span
                      className="ml-1 inline-flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums"
                      style={{ color: t.issues.kind === 'blocking' ? '#EF4444' : '#F59E0B' }}
                    >
                      <Dot kind={t.issues.kind === 'blocking' ? 'blocking' : 'warning'} size={5} />
                      {t.issues.count}
                    </span>
                  )}
                  {reviewedTables.has(t.name) && <ReviewGlyph reviewed size={13} className="ml-1 shrink-0" title="All fields reviewed" />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Review-filter pill chip (black selected / white unselected) ─────────────

function RtlChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{ background: active ? '#111827' : '#FFFFFF', color: active ? '#FFFFFF' : '#374151', borderColor: active ? '#111827' : '#E5E7EB' }}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors hover:opacity-90"
    >
      {children}
    </button>
  )
}

// ─── Delayed tooltip for toolbar pills (~300ms) ──────────────────────────────

function RtlTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enter = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setShow(true), 300)
  }
  const leave = () => {
    if (timer.current) clearTimeout(timer.current)
    setShow(false)
  }
  return (
    <span className="relative inline-flex" onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {show && (
        <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-[#111827] px-2 py-1 text-[11px] text-white">
          {label}
        </span>
      )}
    </span>
  )
}

// ─── Regenerate dropdown ─────────────────────────────────────────────────────

function RtlRegenerate({ count, onRegen }: { count: number; onRegen: (scope: 'pending' | 'table') => void }) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      document.removeEventListener('mousedown', onDown)
      clearTimeout(tid)
    }
  }, [open])
  return (
    <div className="inline-flex shrink-0 items-center gap-2.5" ref={ref}>
      <span className="text-[12px] tabular-nums text-[#6B7280]">
        {count} pending change{count === 1 ? '' : 's'}
      </span>
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{ background: hover ? '#1E47B3' : '#2358D4', color: '#FFFFFF' }}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Regenerate
          <ChevronDown className="h-[11px] w-[11px] text-white/80" />
        </button>
        {open && (
          <div className="absolute right-0 top-full z-50 mt-1.5 w-[200px] rounded-md border border-[#E5E7EB] bg-white py-1 shadow-[0_8px_24px_-6px_rgba(17,24,39,0.14)]">
            {([['pending', `Pending changes (${count})`], ['table', 'Regenerate whole table']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => {
                  onRegen(k)
                  setOpen(false)
                }}
                className="w-full px-3 py-1.5 text-left text-[12.5px] text-[#374151] hover:bg-[#F9FAFB]"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Review progress + primary CTA ───────────────────────────────────────────

function ReviewProgressCTA({ reviewedCount, total, onStart }: { reviewedCount: number; total: number; onStart: () => void }) {
  const left = Math.max(0, total - reviewedCount)
  return (
    <div className="flex shrink-0 items-center gap-3">
      <span className="whitespace-nowrap text-[12.5px] text-[#6B7280]">
        <span className="font-medium tabular-nums text-[#111827]">{reviewedCount}</span> of <span className="tabular-nums">{total}</span> reviewed
      </span>
      <button
        type="button"
        onClick={onStart}
        style={{ background: '#2358D4' }}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#1E47B3]"
      >
        {reviewedCount === 0 ? 'Review fields' : `Resume · ${left} left`}
        <ArrowRight className="h-[13px] w-[13px]" />
      </button>
    </div>
  )
}

// ─── SOURCE-row spec tooltip ─────────────────────────────────────────────────

function RtlSpecTip({ spec, anchorClass = '', children }: { spec: DerivSpec; anchorClass?: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enter = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setShow(true), 300)
  }
  const leave = () => {
    if (timer.current) clearTimeout(timer.current)
    setShow(false)
  }
  return (
    <span className={`relative inline-flex ${anchorClass}`} onMouseEnter={enter} onMouseLeave={leave}>
      {children}
      {show && (
        <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 w-[320px] max-w-[340px] rounded-md border border-[#E5E7EB] bg-white px-3 py-2.5 font-normal normal-case tracking-normal shadow-[0_8px_24px_-6px_rgba(17,24,39,0.12)]">
          <span className="block whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-[#111827]">{spec.expr}</span>
          <span className="mt-2 flex items-center gap-1.5">
            <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: rtlConfColor(spec.conf) }} />
            <span className="text-[11.5px] tabular-nums text-[#374151]">{spec.conf}% confidence</span>
          </span>
          <span className="mt-1.5 block text-[12px] leading-relaxed text-[#6B7280]">{spec.explain}</span>
        </span>
      )}
    </span>
  )
}

// ─── Provenance popover building blocks ──────────────────────────────────────

function RtlProvStep({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[58px_1fr] items-baseline gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">{label}</span>
      <span className="text-[12.5px] leading-snug">{children}</span>
    </div>
  )
}
function RtlProvConnector() {
  return (
    <div className="grid grid-cols-[58px_1fr] gap-2">
      <span />
      <ChevronDown className="my-0.5 h-3 w-3 text-[#D1D5DB]" />
    </div>
  )
}

// ─── Column header sort/filter menu ──────────────────────────────────────────

function ColumnHeaderMenu({
  col,
  meta,
  sortBy,
  filter,
  onSetSort,
  onClearSort,
  onSetFilter,
  onClearFilter,
  onClose,
}: {
  col: ColumnMeta
  meta: TableMeta
  sortBy: SortBy | null
  filter: ColumnFilter | undefined
  onSetSort: (s: SortBy) => void
  onClearSort: () => void
  onSetFilter: (f: ColumnFilter) => void
  onClearFilter: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      clearTimeout(tid)
    }
  }, [onClose])

  const numeric = isNumericType(col.type)
  const distinct = distinctValuesFor(col, meta)
  const cardinality = distinct.length
  const isLow = !numeric && cardinality > 0 && cardinality <= 20
  const isAsc = sortBy && sortBy.key === col.key && sortBy.dir === 'asc'
  const isDesc = sortBy && sortBy.key === col.key && sortBy.dir === 'desc'
  const isSorted = isAsc || isDesc
  const isFiltered = !!filter

  const [q, setQ] = useState(filter && filter.kind === 'text' ? filter.query || '' : '')
  const [rangeMin, setRangeMin] = useState(filter && filter.kind === 'range' ? filter.min ?? '' : '')
  const [rangeMax, setRangeMax] = useState(filter && filter.kind === 'range' ? filter.max ?? '' : '')

  const selectedSet = filter && filter.kind === 'in' ? new Set(filter.values || []) : new Set<string>()
  const toggleValue = (v: string) => {
    const cur = filter && filter.kind === 'in' ? filter.values || [] : []
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
    if (next.length === 0) onClearFilter()
    else onSetFilter({ kind: 'in', values: next })
  }
  const selectAll = () => onSetFilter({ kind: 'in', values: distinct.map((d) => d.value) })

  const searchedDistinct = q.trim() ? distinct.filter((d) => String(d.value).toLowerCase().includes(q.trim().toLowerCase())) : distinct

  const applyTextFilter = (val: string) => {
    if (val.trim() === '') onClearFilter()
    else onSetFilter({ kind: 'text', query: val })
  }
  const applyRange = (min: string, max: string) => {
    if (min === '' && max === '') onClearFilter()
    else onSetFilter({ kind: 'range', min, max })
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-40 mt-1 flex w-[240px] flex-col rounded-md border border-[#E5E7EB] bg-white font-normal normal-case tracking-normal text-[#111827] shadow-[0_8px_24px_-6px_rgba(17,24,39,0.14)]"
      style={{ maxHeight: 400 }}
    >
      <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-[#9CA3AF]">Sort</div>
      <button
        onClick={() => {
          onSetSort({ key: col.key, dir: 'asc' })
          onClose()
        }}
        className={`inline-flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-[#F9FAFB] ${isAsc ? 'font-medium text-[#111827]' : 'text-[#374151]'}`}
      >
        <ArrowUp className="h-3 w-3 text-[#6B7280]" />
        <span>Sort ascending</span>
      </button>
      <button
        onClick={() => {
          onSetSort({ key: col.key, dir: 'desc' })
          onClose()
        }}
        className={`inline-flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-[#F9FAFB] ${isDesc ? 'font-medium text-[#111827]' : 'text-[#374151]'}`}
      >
        <ArrowDown className="h-3 w-3 text-[#6B7280]" />
        <span>Sort descending</span>
      </button>
      {isSorted && (
        <button
          onClick={() => {
            onClearSort()
            onClose()
          }}
          className="px-3 py-1.5 text-left text-[12.5px] text-[#6B7280] hover:bg-[#F9FAFB]"
        >
          Clear sort
        </button>
      )}

      <div className="mt-1 border-t border-[#E5E7EB]" />

      <div className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-[#9CA3AF]">Filter</div>

      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {numeric ? (
          <div className="space-y-2">
            <input
              type="text"
              inputMode="decimal"
              value={rangeMin}
              onChange={(e) => {
                setRangeMin(e.target.value)
                applyRange(e.target.value, rangeMax)
              }}
              placeholder="Min"
              className="w-full rounded-md border border-[#E5E7EB] bg-white px-2 py-1.5 font-mono text-[12px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
            />
            <input
              type="text"
              inputMode="decimal"
              value={rangeMax}
              onChange={(e) => {
                setRangeMax(e.target.value)
                applyRange(rangeMin, e.target.value)
              }}
              placeholder="Max"
              className="w-full rounded-md border border-[#E5E7EB] bg-white px-2 py-1.5 font-mono text-[12px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
            />
          </div>
        ) : isLow ? (
          <div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter values..."
              className="mb-1.5 w-full rounded-md border border-[#E5E7EB] bg-white px-2 py-1.5 text-[12px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
            />
            <div className="mb-1.5 flex items-center gap-2 text-[11.5px]">
              <button onClick={selectAll} className="text-[#3B82F6] hover:underline">
                Select all
              </button>
              <span className="text-[#D1D5DB]">·</span>
              <button onClick={() => onClearFilter()} className="text-[#6B7280] hover:underline">
                Clear
              </button>
            </div>
            <div className="max-h-[200px] space-y-0.5 overflow-y-auto">
              {searchedDistinct.length === 0 && <div className="py-1 text-[12px] italic text-[#9CA3AF]">No matching values.</div>}
              {searchedDistinct.map((d) => (
                <label key={d.value} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-[#F9FAFB]">
                  <input
                    type="checkbox"
                    checked={selectedSet.has(d.value)}
                    onChange={() => toggleValue(d.value)}
                    className="h-3.5 w-3.5 rounded border-[#E5E7EB] accent-[#2358D4]"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#111827]">{d.value}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[#9CA3AF]">{d.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                applyTextFilter(e.target.value)
              }}
              placeholder="Filter values..."
              className="mb-2 w-full rounded-md border border-[#E5E7EB] bg-white px-2 py-1.5 text-[12px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
            />
            {q.trim() && (
              <>
                <div className="max-h-[180px] space-y-0.5 overflow-y-auto">
                  {searchedDistinct.slice(0, 10).map((d) => (
                    <div key={d.value} className="flex items-center gap-2 px-1 py-0.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#111827]">{d.value}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-[#9CA3AF]">{d.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
                {searchedDistinct.length > 10 && (
                  <div className="mt-1 text-[11px] italic text-[#9CA3AF]">Showing 10 of {searchedDistinct.length} — refine your search to see more.</div>
                )}
                {searchedDistinct.length === 0 && <div className="text-[11px] italic text-[#9CA3AF]">No matching values.</div>}
              </>
            )}
          </div>
        )}
      </div>

      {isFiltered && (
        <button
          onClick={() => {
            onClearFilter()
            onClose()
          }}
          className="border-t border-[#E5E7EB] px-3 py-1.5 text-left text-[12.5px] text-[#6B7280] hover:bg-[#F9FAFB]"
        >
          Clear filter
        </button>
      )}
    </div>
  )
}

// ─── SOURCE header cell (single-partition grid, top row) ─────────────────────

function RtlSrcHeadCell({
  spec,
  selected,
  stale,
  regenerating,
  onOpen,
  hovered,
  onEnter,
  onLeave,
  tight,
  dimmed,
}: {
  spec: DerivSpec
  selected: boolean
  stale: boolean
  regenerating: boolean
  onOpen: () => void
  hovered: boolean
  onEnter: () => void
  onLeave: () => void
  tight: boolean
  dimmed: boolean
}) {
  const arrowIdx = (spec.deriv || '').indexOf('→')
  const srcFieldText = spec.srcField || (arrowIdx >= 0 ? spec.deriv.slice(0, arrowIdx).trim() : spec.deriv || '')
  const transformHint = arrowIdx >= 0 ? spec.deriv.slice(arrowIdx).trim() : null
  return (
    <th
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={`rtl-lane relative cursor-pointer overflow-hidden whitespace-nowrap px-5 py-2 text-left align-middle ${stale && !regenerating ? 'rtl-stale' : ''}`}
      style={{
        background: selected ? RTL_FOCUS_TINT : hovered ? RTL_HOVER_TINT : 'var(--color-background-secondary)',
        boxShadow: selected ? RTL_SELECT_BAR : undefined,
      }}
    >
      <RtlSpecTip spec={spec} anchorClass="w-full">
        <span className={`flex w-full items-center gap-1.5 ${dimmed ? 'rtl-dim' : ''}`}>
          <span className={tight ? 'max-w-[124px] truncate' : 'min-w-0'}>
            <span className={`font-mono text-[12px] font-medium ${stale ? 'text-[#9CA3AF]' : 'text-[#111827]'}`}>{srcFieldText}</span>
            {transformHint && <span className="ml-1.5 font-mono text-[11px] font-normal text-[#9CA3AF]">{transformHint}</span>}
          </span>
          {spec.conf < 90 && (
            <span className="ml-auto inline-flex shrink-0 items-center pl-2">
              <span className="inline-block cursor-help rounded-full" title={`Confidence: ${spec.conf}%`} style={{ width: 6, height: 6, background: '#d97706' }} />
            </span>
          )}
        </span>
      </RtlSpecTip>
    </th>
  )
}

// ─── TARGET header cell (single-partition grid, bottom row) ──────────────────

function RtlTgtHeadCell({
  colKey,
  type,
  reviewed,
  selected,
  stale,
  regenerating,
  onOpen,
  onRegenerate,
  hovered,
  onEnter,
  onLeave,
  dimmed,
}: {
  colKey: string
  type: string
  reviewed: boolean
  selected: boolean
  stale: boolean
  regenerating: boolean
  onOpen: () => void
  onRegenerate: () => void
  hovered: boolean
  onEnter: () => void
  onLeave: () => void
  dimmed: boolean
}) {
  return (
    <th
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      data-rtl-col={colKey}
      className={`rtl-lane relative cursor-pointer whitespace-nowrap px-5 py-2 pr-[68px] text-left align-middle ${stale && !regenerating ? 'rtl-stale' : ''}`}
      style={{ background: selected ? RTL_FOCUS_TINT : hovered ? RTL_HOVER_TINT : 'var(--color-background-secondary)' }}
    >
      <span className={`inline-flex min-w-0 items-center gap-1.5 ${dimmed ? 'rtl-dim' : ''}`}>
        <span className={`font-mono text-[12px] font-medium ${stale ? 'text-[#9CA3AF]' : 'text-[#111827]'}`} title={type}>
          {colKey}
        </span>
        <ReviewGlyph reviewed={reviewed} size={12} className="shrink-0" title={reviewed ? 'Reviewed' : 'Needs review'} />
        {(stale || regenerating) &&
          (regenerating ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded border border-[#E5E7EB] bg-white px-1.5 py-[2px] text-[10px] uppercase tracking-wider text-[#6B7280]">
              <RefreshCw className="rtl-spin h-2.5 w-2.5" /> Regenerating…
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRegenerate()
              }}
              className="ml-1 inline-flex items-center gap-1 rounded border border-[#FCD34D] bg-[#FFFBEB] px-1.5 py-[2px] text-[10px] uppercase tracking-wider text-[#92400E] hover:bg-[#FEF3C7]"
              title="Regenerate this column"
            >
              <RefreshCw className="h-2.5 w-2.5" /> Stale · regenerate
            </button>
          ))}
      </span>

      {hovered && (
        <span className="absolute right-4 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 text-[11px] font-medium text-[#6B7280]" title="Edit mapping">
          Edit
          <ArrowRight className="h-[11px] w-[11px]" />
        </span>
      )}
    </th>
  )
}

// ─── TARGET header cell (partitioned grid, single pinned row) ────────────────

function RtlTargetCell({
  colKey,
  type,
  meta,
  sortBy,
  filter,
  stale,
  regenerating,
  selected,
  topCap,
  onOpen,
  onRegenerate,
  onSetSort,
  onClearSort,
  onSetFilter,
  onClearFilter,
  hovered,
  onEnter,
  onLeave,
  showPencil,
}: {
  colKey: string
  type: string
  meta: TableMeta
  sortBy: SortBy | null
  filter: ColumnFilter | undefined
  stale: boolean
  regenerating: boolean
  selected: boolean
  topCap: boolean
  onOpen: () => void
  onRegenerate: () => void
  onSetSort: (s: SortBy) => void
  onClearSort: () => void
  onSetFilter: (key: string, f: ColumnFilter) => void
  onClearFilter: (key: string) => void
  hovered: boolean
  onEnter: () => void
  onLeave: () => void
  showPencil: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <th
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={`group rtl-lane relative cursor-pointer whitespace-nowrap px-5 py-2 text-left align-top ${stale && !regenerating ? 'rtl-stale' : ''}`}
      style={{
        background: selected ? RTL_FOCUS_TINT : hovered ? RTL_HOVER_TINT : 'var(--color-background-secondary)',
        boxShadow: selected && topCap ? RTL_FOCUS_BAR : undefined,
      }}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          className="inline-flex min-w-0 cursor-pointer items-baseline gap-1 hover:opacity-80"
          title={`Open column detail · ${type}`}
        >
          <span className={`font-mono text-[13px] font-medium ${stale ? 'text-[#9CA3AF]' : 'text-[#111827]'}`}>{colKey}</span>
        </button>

        {sortBy && sortBy.key === colKey && (
          sortBy.dir === 'asc' ? <ArrowUp className="h-[11px] w-[11px] text-[#6B7280]" /> : <ArrowDown className="h-[11px] w-[11px] text-[#6B7280]" />
        )}
        {filter && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: '#2358D4' }} aria-label="Filtered" />}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((o) => !o)
          }}
          className={`ml-auto inline-flex h-4 w-4 items-center justify-center rounded text-[#9CA3AF] hover:bg-[#F3F4F6] hover:text-[#6B7280] ${menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          aria-label="Sort / filter"
          title="Sort / filter"
        >
          <ChevronDown className="h-[11px] w-[11px]" />
        </button>
      </div>

      {showPencil && hovered && (
        <span className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center text-[#6B7280]" title="Edit mapping">
          <Pencil className="h-3 w-3" />
        </span>
      )}

      {(stale || regenerating) &&
        (regenerating ? (
          <span className="mt-1.5 inline-flex items-center gap-1 rounded border border-[#E5E7EB] bg-white px-1.5 py-[2px] text-[10px] uppercase tracking-wider text-[#6B7280]">
            <RefreshCw className="rtl-spin h-2.5 w-2.5" />
            Regenerating…
          </span>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRegenerate()
            }}
            className="mt-1.5 inline-flex items-center gap-1 rounded border border-[#FCD34D] bg-[#FFFBEB] px-1.5 py-[2px] text-[10px] uppercase tracking-wider text-[#92400E] hover:bg-[#FEF3C7]"
            title="Regenerate this column"
          >
            <RefreshCw className="h-2.5 w-2.5" />
            Stale · regenerate
          </button>
        ))}

      {menuOpen && (
        <span onClick={(e) => e.stopPropagation()}>
          <ColumnHeaderMenu
            col={{ key: colKey, type }}
            meta={meta}
            sortBy={sortBy}
            filter={filter}
            onSetSort={onSetSort}
            onClearSort={onClearSort}
            onSetFilter={(f) => onSetFilter(colKey, f)}
            onClearFilter={() => onClearFilter(colKey)}
            onClose={() => setMenuOpen(false)}
          />
        </span>
      )}
    </th>
  )
}

// ─── SOURCE cell (partition body source row) ─────────────────────────────────

function RtlSourceCell({ spec, stale, selected, onOpen }: { spec: DerivSpec; stale: boolean; selected: boolean; onOpen: () => void }) {
  return (
    <th
      className={`rtl-lane relative whitespace-nowrap px-5 py-2 text-left align-top ${stale ? 'rtl-stale' : ''}`}
      style={{ background: selected ? RTL_FOCUS_TINT : 'var(--rtl-tint, #FAFAFA)' }}
    >
      <RtlSpecTip spec={spec} anchorClass="w-full">
        <span className="flex w-full items-center gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
            className="inline-flex min-w-0 cursor-pointer items-center hover:opacity-80"
            title="Open column detail"
          >
            <span className="font-mono text-[11px] font-normal text-[#9CA3AF]">{spec.deriv}</span>
          </button>
          {spec.conf < 90 && (
            <span className="ml-auto inline-flex shrink-0 items-center pl-3">
              <span className="inline-block cursor-help rounded-full" title={`Confidence: ${spec.conf}%`} style={{ width: 6, height: 6, background: '#d97706' }} />
            </span>
          )}
        </span>
      </RtlSpecTip>
    </th>
  )
}

// ─── Data cell with read-only provenance popover ─────────────────────────────

function RtlDataCell({
  value,
  spec,
  tgtTable,
  tgtField,
  rowRef,
  flagged,
  selected,
  stale,
  regenerating,
  truncate,
  dimmed,
  colHovered,
  onColEnter,
  onColLeave,
  onOpenIssue,
}: {
  value: string
  spec: DerivSpec
  tgtTable: string
  tgtField: string
  rowRef: string | number
  flagged: Severity | null
  selected: boolean
  stale: boolean
  regenerating: boolean
  truncate: boolean
  dimmed: boolean
  colHovered: boolean
  onColEnter: () => void
  onColLeave: () => void
  onOpenIssue: () => void
}) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const tdRef = useRef<HTMLTableCellElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      clearTimeout(tid)
    }
  }, [open])

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    setOpen((o) => {
      const next = !o
      if (next && tdRef.current) {
        const r = tdRef.current.getBoundingClientRect()
        setFlip(r.left + 336 > window.innerWidth)
      }
      return next
    })
  }

  const bg = selected ? RTL_FOCUS_TINT : colHovered ? RTL_HOVER_TINT : undefined
  const prov = rtlCellProvenance(tgtTable, tgtField, value, spec, flagged)

  return (
    <td
      ref={tdRef}
      onMouseEnter={onColEnter}
      onMouseLeave={onColLeave}
      className={`group rtl-lane relative whitespace-nowrap px-5 py-3 align-middle tabular-nums text-[#111827] ${truncate ? 'overflow-hidden' : ''} ${stale && !regenerating ? 'rtl-stale' : ''}`}
      style={{ background: bg }}
    >
      <button
        type="button"
        onClick={toggle}
        className={`-mx-1 cursor-pointer rounded px-1 text-left hover:bg-[#F3F4F6] ${truncate ? '' : 'font-mono'} ${dimmed ? 'rtl-dim' : ''} ${truncate ? 'block max-w-full truncate' : ''} ${regenerating ? 'rtl-cell-regen' : stale ? 'rtl-cell-stale' : ''}`}
        title={truncate ? String(value) : regenerating ? 'Regenerating…' : 'How was this generated?'}
      >
        {value}
      </button>

      <span className="absolute right-1.5 top-1/2 inline-flex -translate-y-1/2 items-center gap-1">
        <button
          type="button"
          onClick={toggle}
          className={`inline-flex h-5 w-5 items-center justify-center rounded bg-white/90 text-[#9CA3AF] transition-opacity hover:bg-[#F3F4F6] hover:text-[#2358D4] ${open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          aria-label="How was this value generated?"
          title="How was this generated?"
        >
          <Info className="h-[13px] w-[13px]" />
        </button>
        {flagged && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onOpenIssue()
            }}
            className={`inline-flex cursor-pointer items-center justify-center ${flagged === 'blocking' ? 'text-[#EF4444] hover:text-[#DC2626]' : 'text-[#F59E0B] hover:text-[#D97706]'}`}
            title={prov.issue || (flagged === 'blocking' ? 'Blocking issue — click to review' : 'Warning — click to review')}
            aria-label={prov.issue || (flagged === 'blocking' ? 'Blocking issue' : 'Warning')}
          >
            <AlertTriangle className="h-[13px] w-[13px]" />
          </button>
        )}
      </span>

      {open && (
        <div
          ref={ref}
          className={`absolute ${flip ? 'right-2' : 'left-2'} top-full z-50 mt-1 w-[320px] whitespace-normal rounded-md border border-[#E5E7EB] bg-white p-3.5 text-left font-normal normal-case tracking-normal shadow-[0_8px_24px_-6px_rgba(17,24,39,0.14)]`}
        >
          <div className="mb-2.5 flex items-start justify-between">
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-[#9CA3AF]" />
              <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[#9CA3AF]">Generated value</span>
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="-mr-1 -mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded text-[#9CA3AF] hover:bg-[#F3F4F6] hover:text-[#6B7280]"
              aria-label="Close"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          <div className="mb-3 flex items-baseline gap-1.5">
            <span className="font-mono text-[12.5px] text-[#111827]">{tgtField}</span>
            <span className="text-[12px] text-[#9CA3AF]">· row {rowRef}</span>
          </div>

          <div className="flex flex-col">
            <RtlProvStep label="Source">
              <span className="font-mono text-[#6B7280]">{prov.srcField}</span>
              <span className="text-[#9CA3AF]"> = </span>
              <span className="inline-flex items-center rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[2px] font-mono text-[11.5px] text-[#111827]">{rtlProvVal(prov.srcValue)}</span>
            </RtlProvStep>
            <RtlProvConnector />
            <RtlProvStep label="Rule">
              <span className="text-[12.5px] text-[#111827]">{prov.rule}</span>
            </RtlProvStep>
            <RtlProvConnector />
            <RtlProvStep label="Result">
              {prov.resultNull ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="font-mono text-[12px] text-[#B45309]">NULL</span>
                  <span className="text-[11.5px] text-[#9CA3AF]">unresolved</span>
                </span>
              ) : (
                <span className="inline-flex items-center rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[2px] font-mono text-[11.5px] text-[#111827]">{rtlProvVal(prov.result)}</span>
              )}
            </RtlProvStep>
          </div>
        </div>
      )}
    </td>
  )
}

// ─── Partition band (full-width row) ─────────────────────────────────────────

function RtlPartitionBand({ part, collapsed, onToggle, colSpan }: { part: PartitionConfig; collapsed: boolean; onToggle: () => void; colSpan: number }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const tid = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      document.removeEventListener('mousedown', onDown)
      clearTimeout(tid)
    }
  }, [menuOpen])
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <div className="sticky left-0 flex items-center gap-2.5 bg-[#FAFAFA] px-4 py-2.5" style={{ borderLeft: '3px solid #2358D4', width: 'var(--rtl-vw, 100%)' }}>
          <button onClick={onToggle} className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[#6B7280]" aria-label={collapsed ? 'Expand partition' : 'Collapse partition'}>
            {collapsed ? <ChevronRight className="h-[13px] w-[13px]" /> : <ChevronDown className="h-[13px] w-[13px]" />}
          </button>
          <span className="shrink-0 text-[12.5px] font-medium text-[#111827]">{part.name}</span>
          <span className="truncate font-mono text-[11.5px] text-[#6B7280]">
            from {part.source} · {part.filter}
            {part.excludes ? ` · excludes ${part.excludes}` : ''}
          </span>
          <span className="inline-flex shrink-0 items-center rounded-full border border-[#E5E7EB] bg-white px-2 py-[1px] text-[11px] text-[#6B7280]">priority {part.priority}</span>
          <div className="flex-1" />
          <span className="shrink-0 text-[11.5px] tabular-nums text-[#6B7280]">
            {part.rows.toLocaleString()} rows{part.deduped ? <span className="text-[#9CA3AF]"> · {part.deduped} deduped</span> : null}
          </span>
          <div className="relative shrink-0" ref={ref}>
            <button onClick={() => setMenuOpen((o) => !o)} className="inline-flex h-6 w-6 items-center justify-center rounded text-[#9CA3AF] hover:bg-[#F3F4F6] hover:text-[#6B7280]" aria-label="Partition menu">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-[200px] rounded-md border border-[#E5E7EB] bg-white py-1 shadow-[0_8px_24px_-6px_rgba(17,24,39,0.14)]">
                {['Change primary source', 'Reorder priority', 'Edit filter & dedup'].map((label) => (
                  <button key={label} onClick={() => setMenuOpen(false)} className="w-full px-3 py-1.5 text-left text-[12.5px] text-[#374151] hover:bg-[#F9FAFB]">
                    {label}
                  </button>
                ))}
                <div className="my-1 h-px bg-[#E5E7EB]" />
                <button onClick={() => setMenuOpen(false)} className="w-full px-3 py-1.5 text-left text-[12.5px] text-[#EF4444] hover:bg-[#FEF2F2]">
                  Delete partition
                </button>
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}

// ─── Single-partition grid ───────────────────────────────────────────────────

function RtlSingleGrid({
  table,
  meta,
  rows,
  flaggedRowIdx,
  lowConf,
  pendingSet,
  regeneratingSet,
  issueFor,
  selectedKey,
  reviewedFor,
  onOpenColumn,
  onOpenColumnIssues,
  onRegenerateCol,
}: {
  table: string
  meta: TableMeta
  rows: string[][]
  flaggedRowIdx: Set<number> | null
  lowConf: boolean
  pendingSet: Set<string>
  regeneratingSet: Set<string>
  issueFor: (key: string) => CellIssue | null
  selectedKey: string | null
  reviewedFor: (key: string) => boolean
  onOpenColumn: (table: string, key: string, spec: DerivSpec) => void
  onOpenColumnIssues: (table: string, key: string) => void
  onRegenerateCol: (key: string) => void
}) {
  // The design's single-partition grid has no per-column sort/filter menu — that
  // affordance lives only on the partitioned grid's `RtlTargetCell`. So the
  // single grid takes no sort/filter props; rows arrive already sorted/filtered.
  const columns = meta.columns || []
  const shown = rows.slice(0, 10)
  const firstKey = columns[0] && columns[0].key
  const isDimmed = (key: string, spec: DerivSpec) => lowConf && key !== firstKey && spec.conf >= 90
  const GUTTER_W = 80
  const DATA_W = 220
  const truncCol = (key: string) => key === 'description'
  const shortCol = (ci: number) => {
    let max = 0
    for (const r of shown) {
      const v = r[ci]
      if (v != null) max = Math.max(max, String(v).length)
    }
    return max > 0 && max <= 6
  }
  const [hoverCol, setHoverCol] = useState<string | null>(null)
  return (
    <table className="w-full border-collapse text-[12.5px]" style={{ marginRight: selectedKey ? 560 : 0, tableLayout: 'fixed' }}>
      <colgroup>
        <col style={{ width: GUTTER_W }} />
        {columns.map((c) => (
          <col key={c.key} style={{ width: DATA_W }} />
        ))}
      </colgroup>
      <thead className="sticky top-0 z-10">
        <tr className="rtl-divider">
          <th className="text-left align-middle" style={{ background: 'var(--color-background-secondary)' }}>
            <div className="flex items-center px-4 py-2">
              <span className="text-[11px] uppercase tracking-[0.5px] text-[#9CA3AF]">Source</span>
            </div>
          </th>
          {columns.map((c, ci) => {
            const spec = rtlDerivFor(table, c.key)
            return (
              <RtlSrcHeadCell
                key={c.key}
                spec={spec}
                tight={shortCol(ci)}
                dimmed={isDimmed(c.key, spec)}
                stale={pendingSet.has(c.key)}
                regenerating={regeneratingSet.has(c.key)}
                selected={selectedKey === c.key}
                hovered={hoverCol === c.key}
                onEnter={() => setHoverCol(c.key)}
                onLeave={() => setHoverCol(null)}
                onOpen={() => onOpenColumn(table, c.key, spec)}
              />
            )
          })}
        </tr>
        <tr className="rtl-underhead">
          <th className="text-left align-middle" style={{ background: 'var(--color-background-secondary)' }}>
            <div className="flex items-center px-4 py-2">
              <span className="text-[11px] uppercase tracking-[0.5px] text-[#9CA3AF]">Target</span>
            </div>
          </th>
          {columns.map((c) => {
            const spec = rtlDerivFor(table, c.key)
            return (
              <RtlTgtHeadCell
                key={c.key}
                colKey={c.key}
                type={c.type}
                reviewed={reviewedFor(c.key)}
                dimmed={isDimmed(c.key, spec)}
                stale={pendingSet.has(c.key)}
                regenerating={regeneratingSet.has(c.key)}
                selected={selectedKey === c.key}
                hovered={hoverCol === c.key}
                onEnter={() => setHoverCol(c.key)}
                onLeave={() => setHoverCol(null)}
                onOpen={() => onOpenColumn(table, c.key, spec)}
                onRegenerate={() => onRegenerateCol(c.key)}
              />
            )
          })}
        </tr>
      </thead>
      <tbody>
        {shown.map((r, ri) => {
          if (flaggedRowIdx && !flaggedRowIdx.has(ri)) return null
          return (
            <tr key={ri} className="rtl-rowline">
              <td className="select-none px-4 py-3 text-left align-middle text-[11px] tabular-nums text-[#9CA3AF]">{ri + 1}</td>
              {r.map((v, ci) => {
                const c = columns[ci]
                if (!c) return null
                const spec = rtlDerivFor(table, c.key)
                const info = issueFor(c.key)
                const flagged = info && (info.rows || []).includes(ri) ? info.sev : null
                return (
                  <RtlDataCell
                    key={ci}
                    value={v}
                    spec={spec}
                    tgtTable={table}
                    tgtField={c.key}
                    rowRef={ri + 1}
                    flagged={flagged}
                    selected={selectedKey === c.key}
                    stale={pendingSet.has(c.key)}
                    regenerating={regeneratingSet.has(c.key)}
                    dimmed={isDimmed(c.key, spec)}
                    truncate={truncCol(c.key)}
                    colHovered={hoverCol === c.key}
                    onColEnter={() => setHoverCol(c.key)}
                    onColLeave={() => setHoverCol(null)}
                    onOpenIssue={() => onOpenColumnIssues(table, c.key)}
                  />
                )
              })}
            </tr>
          )
        })}
        {shown.length === 0 && (
          <tr>
            <td colSpan={columns.length + 1} className="px-6 py-12 text-center text-[12.5px] text-[#9CA3AF]">
              No rows match the current filters.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

// ─── Partitioned grid ────────────────────────────────────────────────────────

function RtlPartitionedGrid({
  table,
  meta,
  pendingSet,
  regeneratingSet,
  collapsed,
  selectedKey,
  onToggle,
  onOpenColumn,
  onOpenColumnIssues,
  onRegenerateCol,
  sortBy,
  filters,
  onSetSort,
  onClearSort,
  onSetFilter,
  onClearFilter,
}: {
  table: string
  meta: TableMeta
  pendingSet: Set<string>
  regeneratingSet: Set<string>
  collapsed: Record<string, boolean>
  selectedKey: string | null
  onToggle: (id: string) => void
  onOpenColumn: (table: string, key: string, spec: DerivSpec) => void
  onOpenColumnIssues: (table: string, key: string) => void
  onRegenerateCol: (key: string) => void
  sortBy: SortBy | null
  filters: Record<string, ColumnFilter>
  onSetSort: (s: SortBy | null) => void
  onClearSort: () => void
  onSetFilter: (key: string, f: ColumnFilter) => void
  onClearFilter: (key: string) => void
}) {
  const columns = meta.columns || []
  const cfg = READY_PARTITIONS[table]
  const colSpan = columns.length + 1
  const [hoverCol, setHoverCol] = useState<string | null>(null)
  return (
    <table className="w-full border-collapse text-[12.5px]">
      <thead className="sticky top-0 z-10">
        <tr className="rtl-underhead">
          <th className="px-4 py-2 text-left align-top" style={{ background: 'var(--color-background-secondary)' }}>
            <span className="text-[11px] uppercase tracking-[0.5px] text-[#9CA3AF]">Target</span>
          </th>
          {columns.map((c) => {
            const spec = rtlDerivFor(table, c.key)
            return (
              <RtlTargetCell
                key={c.key}
                colKey={c.key}
                type={c.type}
                meta={meta}
                sortBy={sortBy}
                filter={filters[c.key]}
                stale={pendingSet.has(c.key)}
                regenerating={regeneratingSet.has(c.key)}
                selected={selectedKey === c.key}
                onOpen={() => onOpenColumn(table, c.key, spec)}
                onRegenerate={() => onRegenerateCol(c.key)}
                onSetSort={onSetSort}
                onClearSort={onClearSort}
                onSetFilter={onSetFilter}
                onClearFilter={onClearFilter}
                topCap
                hovered={hoverCol === c.key}
                onEnter={() => setHoverCol(c.key)}
                onLeave={() => setHoverCol(null)}
                showPencil
              />
            )
          })}
        </tr>
      </thead>
      <tbody>
        {cfg.partitions.map((part) => {
          const isCollapsed = !!collapsed[part.id]
          return (
            <Fragment key={part.id}>
              <RtlPartitionBand part={part} collapsed={isCollapsed} onToggle={() => onToggle(part.id)} colSpan={colSpan} />
              {!isCollapsed && (
                <>
                  <tr className="rtl-divider">
                    <th className="px-4 py-2 text-left align-top" style={{ background: '#FAFAFA' }}>
                      <span className="text-[11px] uppercase tracking-[0.5px] text-[#9CA3AF]">Source</span>
                    </th>
                    {columns.map((c) => {
                      const spec = part.deriv[c.key] || rtlDerivFor(table, c.key)
                      return <RtlSourceCell key={c.key} spec={spec} stale={pendingSet.has(c.key)} selected={selectedKey === c.key} onOpen={() => onOpenColumn(table, c.key, spec)} />
                    })}
                  </tr>
                  {part.data.map((r, ri) => (
                    <tr key={ri} className="rtl-rowline">
                      <td className="select-none px-4 py-2 text-left text-[11px] tabular-nums text-[#9CA3AF]">{ri + 1}</td>
                      {r.map((v, ci) => {
                        const c = columns[ci]
                        if (!c) return null
                        const spec = part.deriv[c.key] || rtlDerivFor(table, c.key)
                        return (
                          <RtlDataCell
                            key={ci}
                            value={v}
                            spec={spec}
                            tgtTable={table}
                            tgtField={c.key}
                            rowRef={`${part.id}·${ri + 1}`}
                            flagged={null}
                            selected={selectedKey === c.key}
                            stale={pendingSet.has(c.key)}
                            regenerating={regeneratingSet.has(c.key)}
                            truncate={false}
                            dimmed={false}
                            colHovered={hoverCol === c.key}
                            onColEnter={() => setHoverCol(c.key)}
                            onColLeave={() => setHoverCol(null)}
                            onOpenIssue={() => onOpenColumnIssues(table, c.key)}
                          />
                        )
                      })}
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={colSpan} className="border-b border-[#F3F4F6] px-4 py-2">
                      <button className="text-[12px] hover:underline" style={{ color: '#2358D4' }}>
                        Show all {part.rows.toLocaleString()} rows in {part.name}
                      </button>
                    </td>
                  </tr>
                </>
              )}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Review drawer (the design's target-lens FieldDetailPanel + RtlReviewBody) ─
// An ABSOLUTE overlay bracketed to the table card. It reviews a single TARGET
// field — header/body driven entirely from the data the grid already carries
// (rtlDerivFor / rtlValidationFor / sample values). All edit + validation
// working state is local and reset per field; nothing is persisted.

type TransformMode = 'none' | 'transform' | 'value'

interface RtlReviewSpecState {
  srcTable: string
  srcField: string
  transformMode: TransformMode
  desc: string
  sqlText: string
  valueText: string
}

interface ReviewVersionEntry {
  who: string
  kind: 'user' | 'fix' | 'system'
  relative: string
  when: string
  summary: string
  before: string
  after: string
}

const REVIEW_RULES: { id: string; origin: 'ai' | 'user'; text: string }[] = [
  { id: 'r1', origin: 'ai', text: 'Value must be present after transform; null loads are flagged.' },
  { id: 'r2', origin: 'ai', text: 'Trim leading and trailing whitespace before load.' },
  { id: 'r3', origin: 'user', text: "Skip rows where the source key matches 'TEST-*'." },
]

const REVIEW_VERSION_ENTRIES: ReviewVersionEntry[] = [
  { who: 'Kaan Dincer', kind: 'user', relative: '1 hour ago', when: 'May 23, 5:14 PM', summary: 'Transform applied', before: '— (draft)', after: "'ACCT-' || ACCT_NO" },
  { who: 'Kaan Dincer', kind: 'fix', relative: '3 hours ago', when: 'May 23, 3:01 PM', summary: "Fix applied: SQL parse error — added 'ACCT-' prefix to BRANCH_NO transform", before: 'BRANCH_NO transform failed: missing prefix', after: "'ACCT-' || BRANCH_NO" },
  { who: 'System', kind: 'system', relative: '1 day ago', when: 'May 22, 4:32 PM', summary: 'Transform validated against sample (412 rows)', before: '0 / 412 sampled', after: '412 / 412 passed validation' },
  { who: 'Kaan Dincer', kind: 'user', relative: '1 day ago', when: 'May 22, 4:18 PM', summary: 'Edited transform — added ACCT- prefix to source value', before: 'ACCT_NO', after: "'ACCT-' || ACCT_NO" },
  { who: 'Kaan Dincer', kind: 'fix', relative: '2 days ago', when: 'May 21, 11:48 AM', summary: 'Fix applied: Type mismatch — cast OPEN_DT VARCHAR to DATE before mapping', before: 'OPEN_DT VARCHAR(10) → opened_date DATE failed cast', after: "TO_DATE(OPEN_DT, 'YYYY-MM-DD') AS opened_date" },
  { who: 'System', kind: 'system', relative: '2 days ago', when: 'May 21, 9:02 AM', summary: 'Generated transform: pass-through direct map', before: '— (no transform)', after: 'ACCT_NO' },
]

interface ReviewAlternative {
  src: string
  approach: string
  conf: number
  reason: string
}

// Runner-up mappings the AI weighed but didn't pick. Surfaced only where the
// model considered real alternatives; every other field returns [].
function reviewAlternativesFor(table: string, field: string): ReviewAlternative[] {
  if (table === 'Commodity Codes' && field === 'commodity_class')
    return [
      { src: 'CLASS_CD', approach: 'pass-through', conf: 63, reason: 'Load the raw class codes unchanged — only if Rootstock accepts legacy values.' },
      { src: 'CLASS_CD + COMM_HINT', approach: 'coalesce → lookup', conf: 54, reason: 'Fall back to COMM_HINT when CLASS_CD is blank, then resolve via class_map.' },
    ]
  return []
}

// Natural-language seed for the transform editor's description view, derived
// from the field's expr.
function reviewTransformNL(spec: DerivSpec): string {
  const e = spec.expr || ''
  if (/TRIM/i.test(e)) return 'Trim trailing whitespace from the source value.'
  if (/gl_map/i.test(e)) return 'Look up the full GL account from gl_map by code; null when unmatched.'
  if (/class_map/i.test(e)) return 'Look up the full class name from class_map by code.'
  if (/CASE/i.test(e)) return 'Cast the Y/N flag to a boolean (Y → true, N → false).'
  if (/COALESCE/i.test(e)) return 'Fall back to the secondary source when the primary value is null.'
  return spec.explain || ''
}

function reviewModeForDeriv(deriv: string): TransformMode {
  if (/\(const\)/.test(deriv)) return 'value'
  if (!/[→(]/.test(deriv)) return 'none'
  return 'transform'
}

// One-line transform summary shown in read state: [mode, detail].
function reviewSummary(c: RtlReviewSpecState): [string, string] {
  if (c.transformMode === 'none') return ['None', 'pass-through']
  if (c.transformMode === 'value') return ['Set value', `'${c.valueText || 'constant'}'`]
  const e = c.sqlText || ''
  let d = 'transform applied'
  if (/TRIM/i.test(e)) d = 'trailing-whitespace trim'
  else if (/gl_map/i.test(e)) d = 'lookup via gl_map'
  else if (/class_map/i.test(e)) d = 'lookup via class_map'
  else if (/SELECT/i.test(e)) d = 'lookup via map'
  else if (/CASE/i.test(e)) d = 'cast Y/N to boolean'
  else if (/COALESCE/i.test(e)) d = 'COALESCE fallback'
  return ['Transform', d]
}

function reviewInitialState(spec: DerivSpec): RtlReviewSpecState {
  const mode = reviewModeForDeriv(spec.deriv || '')
  return {
    srcTable: spec.srcTable,
    srcField: spec.srcField,
    transformMode: mode,
    desc: reviewTransformNL(spec),
    sqlText: spec.expr || '',
    valueText: mode === 'value' ? String(spec.expr || '').replace(/'/g, '') : '',
  }
}

function reviewFixSqlFor(field: string): string {
  if (field === 'default_gl_account') return "COALESCE((SELECT gl_account FROM gl_map g WHERE g.code = c.GL_ACCT), '6200-MRO')"
  if (field === 'commodity_class') return "COALESCE((SELECT class_name FROM class_map cm WHERE cm.code = c.CLASS_CD), 'Uncategorized')"
  return `COALESCE(${field.toUpperCase()}, '')`
}

function ReviewVersionHistoryView({ onBack }: { onBack: () => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggle = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[#E5E7EB] px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-[#6B7280] hover:bg-[#F9FAFB] hover:text-[#111827]"
          aria-label="Back to details"
          title="Back to details"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-[13px] font-medium text-[#111827]">Version history</span>
        <span className="ml-1 text-[11.5px] tabular-nums text-[#9CA3AF]">{REVIEW_VERSION_ENTRIES.length} entries</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {REVIEW_VERSION_ENTRIES.map((e, i) => {
          const open = expanded.has(i)
          const badgeClass =
            e.kind === 'system'
              ? 'text-[#6B7280] border-[#E5E7EB] bg-[#F9FAFB]'
              : e.kind === 'fix'
                ? 'text-[#047857] border-[#A7F3D0] bg-[#ECFDF5]'
                : 'text-[#1D4ED8] border-[#DBEAFE] bg-[#EFF6FF]'
          const BadgeIcon = e.kind === 'system' ? Cpu : e.kind === 'fix' ? Sparkles : User
          return (
            <div key={i} className={`px-5 py-3 ${i !== REVIEW_VERSION_ENTRIES.length - 1 ? 'border-b border-[#E5E7EB]' : ''}`}>
              <button
                type="button"
                onClick={() => toggle(i)}
                className="group flex w-full items-start gap-3 text-left"
                aria-expanded={open}
              >
                <span
                  className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center text-[#9CA3AF] transition-transform ${open ? 'rotate-90' : ''}`}
                >
                  <ChevronRight className="h-3 w-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] tabular-nums text-[#6B7280]">
                    {e.relative} <span className="mx-1 text-[#D1D5DB]">·</span> {e.when}
                  </span>
                  <span className="mt-1 block">
                    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[11px] font-medium uppercase tracking-wider ${badgeClass}`}>
                      <BadgeIcon className="h-2.5 w-2.5" />
                      {e.who}
                    </span>
                  </span>
                  <span className="mt-1.5 block text-[13px] leading-snug text-[#111827]">{e.summary}</span>
                </span>
              </button>

              {open ? (
                <div className="ml-8 mt-3 overflow-hidden rounded-md border border-[#E5E7EB]">
                  <div className="grid grid-cols-[80px_1fr] text-[12px]">
                    <div className="border-b border-r border-[#E5E7EB] bg-[#F9FAFB] px-3 py-2 text-[10.5px] font-medium uppercase tracking-wider text-[#9CA3AF]">Before</div>
                    <div className="truncate border-b border-[#E5E7EB] bg-white px-3 py-2 font-mono text-[12px] text-[#6B7280]">{e.before}</div>
                    <div className="border-r border-[#E5E7EB] bg-[#F9FAFB] px-3 py-2 text-[10.5px] font-medium uppercase tracking-wider text-[#9CA3AF]">After</div>
                    <div className="truncate bg-white px-3 py-2 font-mono text-[12px] text-[#111827]">{e.after}</div>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface ReviewField {
  table: string
  field: string
  type: string
}

function FieldPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[3px] font-mono text-[12px] text-[#111827] truncate">
      {children}
    </span>
  )
}

function DataPreviewReviewDrawer({
  table,
  field,
  type,
  index,
  total,
  isLast,
  continueAllowed,
  blockingLeft,
  reviewed,
  flaggedUnresolved,
  initiallyResolved,
  scrollTick,
  scrollToIssues,
  hasPrev,
  hasNext,
  onSetReviewed,
  onSetResolved,
  onPrev,
  onNext,
  onContinue,
  onClose,
}: {
  table: string
  field: string
  type: string
  index: number
  total: number
  isLast: boolean
  continueAllowed: boolean
  blockingLeft: number
  reviewed: boolean
  flaggedUnresolved: boolean
  initiallyResolved: boolean
  scrollTick: number
  scrollToIssues: boolean
  hasPrev: boolean
  hasNext: boolean
  onSetReviewed: (val: boolean) => void
  onSetResolved: (val: boolean) => void
  onPrev: () => void
  onNext: () => void
  onContinue: () => void
  onClose: () => void
}) {
  const spec = rtlDerivFor(table, field)
  const baseValidation = rtlValidationFor(table, field)
  const tgtType = type
  const srcType = spec.srcField === '—' ? '—' : 'VARCHAR(20)'

  const [historyOpen, setHistoryOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [altsOpen, setAltsOpen] = useState(false)

  const [committed, setCommitted] = useState<RtlReviewSpecState>(() => reviewInitialState(spec))
  const [draft, setDraft] = useState<RtlReviewSpecState>(() => reviewInitialState(spec))
  const [editing, setEditing] = useState(false)
  const [sqlView, setSqlView] = useState(false)
  const [rationale, setRationale] = useState(spec.explain)
  const [regenRat, setRegenRat] = useState(false)
  const [valCleared, setValCleared] = useState(false)
  const [accepted, setAccepted] = useState(initiallyResolved)
  const [testing, setTesting] = useState(false)

  const moreRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const valRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Fixed-height overlay: anchored from the top of the table area down to the
  // bottom of the viewport, leaving the page's bottom margin. Measured so the
  // pinned footer is always visible. Re-measures on open, resize, and scroll.
  const [panelH, setPanelH] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => {
      const top = el.getBoundingClientRect().top
      setPanelH(Math.max(220, Math.round(window.innerHeight - top - 24)))
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [table, field])

  // Reset all working state when the drawer navigates to another field.
  useEffect(() => {
    const init = reviewInitialState(spec)
    setCommitted(init)
    setDraft(init)
    setHistoryOpen(false)
    setMoreOpen(false)
    setRulesOpen(false)
    setAltsOpen(false)
    setEditing(false)
    setSqlView(false)
    setRationale(spec.explain)
    setRegenRat(false)
    setValCleared(false)
    setAccepted(initiallyResolved)
    setTesting(false)
    // reason: spec is recomputed each render from the table|field pair; the
    // table|field key is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, field])

  // Sync resolution to the shared review store so the grid glyphs + footer
  // checkbox agree: a flagged field is resolved once accepted or its validation
  // clears.
  useEffect(() => {
    onSetResolved(!baseValidation || valCleared || accepted)
    // reason: onSetResolved identity is stable enough for this mock; the
    // resolution inputs are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseValidation, valCleared, accepted, table, field])

  // Scroll to the validation block when an issue "Review" link requested it.
  useEffect(() => {
    if (!bodyRef.current) return
    if (scrollToIssues && valRef.current) {
      const body = bodyRef.current
      const val = valRef.current
      requestAnimationFrame(() => {
        body.scrollTop = Math.max(0, val.offsetTop - 8)
      })
    } else {
      bodyRef.current.scrollTop = 0
    }
  }, [scrollTick, scrollToIssues, table, field])

  useEffect(() => {
    if (!moreOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [moreOpen])

  // Esc + click-outside close. The deferred mousedown bind keeps the opening
  // click from closing the drawer; clicks on a grid column header re-target the
  // drawer in place (handled by the header's own onClick) instead of closing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t) return
      if (rootRef.current && rootRef.current.contains(t)) return
      if (t.closest('[data-rtl-col], button, [role="button"], input, label')) return
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.clearTimeout(id)
    }
  }, [])

  const resolved = !baseValidation || valCleared || accepted
  const canToggleReviewed = !flaggedUnresolved || reviewed
  const alternatives = reviewAlternativesFor(table, field)
  const [summaryMode, summaryDetail] = reviewSummary(committed)

  const enterEdit = () => {
    setDraft({ ...committed })
    setEditing(true)
  }
  const discard = () => {
    setDraft({ ...committed })
    setSqlView(false)
    setEditing(false)
  }
  const save = () => {
    setCommitted({ ...draft })
    setEditing(false)
  }
  const generate = () => {
    setRegenRat(true)
    window.setTimeout(() => {
      setDraft((d) => ({ ...d, transformMode: 'transform', sqlText: d.sqlText || spec.expr || `TRIM(${d.srcField})` }))
      setSqlView(true)
      setRegenRat(false)
    }, 700)
  }
  const applyTest = () => {
    setTesting(true)
    window.setTimeout(() => {
      const fixed = draft.sqlText !== (spec.expr || '') || draft.transformMode !== committed.transformMode
      setValCleared(fixed)
      setTesting(false)
    }, 800)
  }
  const regenerateRationale = () => {
    setRegenRat(true)
    window.setTimeout(() => {
      setRationale(`${spec.explain} Re-evaluated against the current mapping and transform.`)
      setRegenRat(false)
    }, 700)
  }
  const fix = () => {
    setDraft((d) => ({
      ...d,
      transformMode: 'transform',
      sqlText: reviewFixSqlFor(field),
      desc: 'Resolve unmatched codes via lookup; default the remainder rather than loading NULL.',
    }))
    setSqlView(true)
    setAccepted(false)
    setEditing(true)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }

  const renderValidation = () => {
    if (testing) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] text-[#6B7280]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#9CA3AF]" />
          Running dry-run…
        </div>
      )
    }
    if (!baseValidation || valCleared) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] font-normal text-[#9CA3AF]">
          <Check className="h-[13px] w-[13px] shrink-0 text-[#16A34A]" strokeWidth={2} />
          Passes all checks
        </div>
      )
    }
    if (accepted && !editing) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] text-[#6B7280]">
          <Check className="h-[13px] w-[13px] shrink-0 text-[#9CA3AF]" strokeWidth={2} />
          Accepted with issue logged · {baseValidation.count} row{baseValidation.count === 1 ? '' : 's'}
          <button type="button" onClick={() => setAccepted(false)} className="ml-1 text-[12px] text-[#2358D4] hover:underline">
            Undo
          </button>
        </div>
      )
    }
    const blocking = baseValidation.sev === 'blocking'
    const color = blocking ? '#DC2626' : '#D97706'
    const bg = blocking ? '#FEF2F2' : '#FFFBEB'
    const border = blocking ? '#FECACA' : '#FDE68A'
    const headColor = blocking ? '#991B1B' : '#92400E'
    return (
      <div className="rounded-md border px-3.5 py-3" style={{ background: bg, borderColor: border }}>
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-[15px] w-[15px] shrink-0" style={{ color }} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-snug" style={{ color: headColor }}>
              {baseValidation.count} row{baseValidation.count === 1 ? '' : 's'} · {baseValidation.heading}
            </div>
            {baseValidation.values.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {baseValidation.values.map((v, i) => (
                  <span
                    key={i}
                    className="rounded border bg-white/70 px-1.5 py-[2px] font-mono text-[11.5px] text-[#374151]"
                    style={{ borderColor: border }}
                  >
                    {v}
                  </span>
                ))}
              </div>
            ) : null}
            {editing ? (
              <div className="mt-2.5 text-[12px] text-[#6B7280]">Re-runs on Apply &amp; Test.</div>
            ) : (
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={fix}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#2358D4] px-2.5 py-1.5 text-[12.5px] font-medium text-white transition-colors hover:bg-[#1E47B3]"
                >
                  <Wrench className="h-3 w-3" /> Fix
                </button>
                <button
                  type="button"
                  onClick={() => setAccepted(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
                >
                  Accept
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  const confColor = spec.conf >= 90 ? '#10B981' : '#F59E0B'
  const issueCount = baseValidation && !resolved ? baseValidation.count : 0
  const issueSev = baseValidation ? baseValidation.sev : 'warning'

  return (
    <aside
      ref={rootRef}
      className="absolute z-30 flex w-[440px] flex-col rounded-lg border border-[#E5E7EB] bg-white shadow-[-10px_0_30px_-14px_rgba(17,24,39,0.18)]"
      style={{ top: 'var(--rtl-drawer-top, 65px)', right: 0, height: panelH ? `${panelH}px` : 'var(--rtl-drawer-fill, calc(100vh - 220px))' }}
      aria-label="Field detail"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#E5E7EB] bg-white">
        <div className="flex min-w-0 items-center gap-2 pl-[22px]">
          <span className="inline-block h-3.5 w-0.5 shrink-0 rounded-full bg-[#2358D4]" aria-hidden="true" />
          <span className="truncate font-mono text-[13px] font-medium text-[#111827]" title={`${table} · ${field}`}>
            {field}
          </span>
          <ReviewGlyph reviewed={reviewed} size={13} className="shrink-0" title={reviewed ? 'Reviewed' : 'Needs review'} />
        </div>
        <div className="flex items-center gap-2 px-3 text-[11.5px] text-[#6B7280]">
          <span className="inline-flex shrink-0 items-center gap-1" title={`${spec.conf}% confidence`}>
            <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: confColor }} aria-hidden="true" />
            <span className="font-mono tabular-nums text-[11px]">{spec.conf}%</span>
          </span>
          {issueCount > 0 ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums"
              style={{ color: issueSev === 'blocking' ? '#EF4444' : '#F59E0B' }}
              title={`${issueCount} ${issueSev === 'blocking' ? 'blocking issue' : 'warning'}${issueCount === 1 ? '' : 's'}`}
            >
              <AlertTriangle className="h-3 w-3" />
              {issueCount}
            </span>
          ) : null}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className={`inline-flex h-7 w-7 items-center justify-center rounded ${historyOpen ? 'bg-[#EFF6FF] text-[#3B82F6]' : 'text-[#6B7280] hover:bg-[#F9FAFB] hover:text-[#111827]'}`}
              title="Version history"
              aria-pressed={historyOpen}
            >
              <Clock className="h-3.5 w-3.5" />
            </button>
            <div ref={moreRef} className="relative">
              <button
                type="button"
                onClick={() => setMoreOpen((o) => !o)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded ${moreOpen ? 'bg-[#F3F4F6] text-[#111827]' : 'text-[#6B7280] hover:bg-[#F9FAFB] hover:text-[#111827]'}`}
                title="More"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {moreOpen ? (
                <div role="menu" className="absolute right-0 top-full z-50 mt-1 min-w-[170px] rounded-lg border border-[#E5E7EB] bg-white p-1 shadow-[0_6px_16px_-6px_rgba(17,24,39,0.12)]">
                  <button
                    type="button"
                    onClick={() => setMoreOpen(false)}
                    className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-[#111827] hover:bg-[#F3F4F6]"
                  >
                    <BookOpen className="h-3.5 w-3.5 text-[#6B7280]" />
                    View in glossary
                  </button>
                  <div className="my-1 h-px bg-[#E5E7EB]" />
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      onClose()
                    }}
                    className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-[#EF4444] hover:bg-[#FEF2F2]"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-[#EF4444]" />
                    Remove mapping
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded text-[#9CA3AF] hover:bg-[#F9FAFB] hover:text-[#6B7280]"
              title="Close"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {historyOpen ? (
        <ReviewVersionHistoryView onBack={() => setHistoryOpen(false)} />
      ) : (
        <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <section className="border-b border-[#E5E7EB] px-5 py-6">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate font-mono text-[12px] text-[#6B7280]">
                {(editing ? draft.srcTable : committed.srcTable)} <span className="text-[#9CA3AF]">→</span> {table}
              </div>
              {!editing ? (
                <button
                  type="button"
                  onClick={enterEdit}
                  className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-[#2358D4] underline-offset-2 hover:underline"
                >
                  <Pencil className="h-3 w-3" /> Edit
                </button>
              ) : null}
            </div>

            <div className="mt-3.5 grid grid-cols-[1fr_auto_1fr] items-start gap-3">
              <div>
                <FieldPill>{editing ? draft.srcField : committed.srcField}</FieldPill>
                <div className="mt-1.5 font-mono text-[11.5px] text-[#9CA3AF]">{srcType}</div>
              </div>
              <div className="pt-1.5">
                <ArrowRight className="h-4 w-4 text-[#9CA3AF]" />
              </div>
              <div>
                <FieldPill>{field}</FieldPill>
                <div className="mt-1.5 font-mono text-[11.5px] text-[#9CA3AF]">{tgtType}</div>
              </div>
            </div>

            {!editing ? (
              <>
                <div className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-[#6B7280]">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#1D9E75]" />
                  <span className="min-w-0">{rationale}</span>
                </div>
                <div className="mt-4 flex items-center gap-2 text-[12.5px]">
                  <span className="font-medium text-[#6B7280]">{summaryMode}</span>
                  <span className="text-[#D1D5DB]">·</span>
                  <span className="text-[#111827]">{summaryDetail}</span>
                </div>
              </>
            ) : (
              <>
                <div className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-[#6B7280]">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#1D9E75]" />
                  <span className="min-w-0 flex-1">{regenRat ? 'Regenerating rationale…' : rationale}</span>
                  <button
                    type="button"
                    onClick={regenerateRationale}
                    className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[#2358D4] underline-offset-2 hover:underline"
                  >
                    <RefreshCw className={`h-3 w-3 ${regenRat ? 'animate-spin' : ''}`} /> Regenerate
                  </button>
                </div>

                <div className="mt-5 flex items-center gap-3">
                  <div className="inline-flex rounded-full border border-[#E5E7EB] bg-white p-0.5">
                    {(
                      [
                        { v: 'none', label: 'None' },
                        { v: 'transform', label: 'Transform' },
                        { v: 'value', label: 'Set value' },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.v}
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, transformMode: o.v }))}
                        className={`whitespace-nowrap rounded-full px-3 py-0.5 text-[11.5px] font-medium ${draft.transformMode === o.v ? 'bg-[#111827] text-white' : 'text-[#6B7280] hover:text-[#111827]'}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex-1" />
                  {draft.transformMode === 'transform' ? (
                    <button
                      type="button"
                      onClick={() => setSqlView((v) => !v)}
                      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium ${sqlView ? 'border-[#2358D4] bg-[#EFF4FE] text-[#2358D4]' : 'border-[#E5E7EB] bg-white text-[#6B7280] hover:text-[#111827]'}`}
                      title={sqlView ? 'Show description' : 'Show generated SQL'}
                    >
                      <Code className="h-3 w-3" />
                      SQL
                    </button>
                  ) : null}
                </div>

                {draft.transformMode === 'none' ? (
                  <div className="mt-4 text-[13px] italic text-[#6B7280]">No transformation — value passes through unchanged.</div>
                ) : null}
                {draft.transformMode === 'value' ? (
                  <div className="mt-4">
                    <input
                      type="text"
                      value={draft.valueText}
                      onChange={(e) => setDraft((d) => ({ ...d, valueText: e.target.value }))}
                      placeholder="Enter value…"
                      spellCheck={false}
                      className="w-full rounded-md border border-[#E5E7EB] bg-white px-3 py-2 font-mono text-[12.5px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
                    />
                  </div>
                ) : null}
                {draft.transformMode === 'transform' ? (
                  <div className="mt-4">
                    <textarea
                      value={sqlView ? draft.sqlText : draft.desc}
                      onChange={(e) => (sqlView ? setDraft((d) => ({ ...d, sqlText: e.target.value })) : setDraft((d) => ({ ...d, desc: e.target.value })))}
                      placeholder='e.g., "Standardize date formats to ISO 8601"'
                      spellCheck={false}
                      rows={4}
                      className={`w-full resize-y rounded-md border border-[#E5E7EB] bg-white p-3 text-[13px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6] ${sqlView ? 'bg-[#F9FAFB] font-mono text-[12.5px]' : ''}`}
                    />
                  </div>
                ) : null}

                {draft.transformMode !== 'none' ? (
                  <div className="mt-4 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={generate}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-[#374151] hover:bg-[#F9FAFB]"
                    >
                      <Sparkles className="h-3 w-3 text-[#1D9E75]" /> Generate
                    </button>
                    <button
                      type="button"
                      onClick={applyTest}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-[#374151] hover:bg-[#F9FAFB]"
                    >
                      <Play className="h-3 w-3" /> Apply &amp; Test
                    </button>
                  </div>
                ) : null}

                <div className="mt-6 flex items-center gap-3 border-t border-[#E5E7EB] pt-4">
                  <button
                    type="button"
                    onClick={discard}
                    className="text-[12.5px] text-[#6B7280] underline underline-offset-2 hover:text-[#111827]"
                  >
                    Discard changes
                  </button>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={save}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#2358D4] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[#1E47B3]"
                  >
                    Save
                  </button>
                </div>
              </>
            )}
          </section>

          <section ref={valRef} className="border-b border-[#E5E7EB] px-5 py-5">
            {renderValidation()}
          </section>

          {alternatives.length > 0 ? (
            <section className="border-b border-[#E5E7EB] px-5 py-5">
              <button
                type="button"
                onClick={() => setAltsOpen((v) => !v)}
                aria-expanded={altsOpen}
                className="flex w-full items-center gap-2 text-left text-[#6B7280] hover:text-[#111827]"
              >
                <Layers className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" />
                <span className="text-[12px] font-semibold uppercase tracking-wider">Alternatives considered · {alternatives.length}</span>
                <div className="flex-1" />
                {altsOpen ? <ChevronDown className="h-3.5 w-3.5 text-[#9CA3AF]" /> : <ChevronRight className="h-3.5 w-3.5 text-[#9CA3AF]" />}
              </button>
              {altsOpen ? (
                <div className="mt-3 divide-y divide-[#F1F1F4] pl-[22px]">
                  {alternatives.map((a, i) => (
                    <div key={i} className="py-2.5 first:pt-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 text-[13px] leading-snug">
                          <span className="font-mono text-[12.5px] text-[#111827]">{a.src}</span>
                          <span className="mx-1.5 text-[#D1D5DB]">·</span>
                          <span className="text-[#6B7280]">{a.approach}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="inline-flex items-center gap-1" title={`${a.conf}% confidence`}>
                            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: a.conf >= 90 ? '#10B981' : '#F59E0B' }} aria-hidden="true" />
                            <span className="font-mono text-[11px] tabular-nums text-[#6B7280]">{a.conf}%</span>
                          </span>
                          <button type="button" className="whitespace-nowrap text-[12px] font-medium text-[#2358D4] hover:underline">
                            Use this
                          </button>
                        </div>
                      </div>
                      <div className="mt-1 text-[12.5px] leading-snug text-[#9CA3AF]">{a.reason}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="border-b border-[#E5E7EB] px-5 py-5">
            <button
              type="button"
              onClick={() => setRulesOpen((v) => !v)}
              aria-expanded={rulesOpen}
              className="flex w-full items-center gap-2 text-left text-[#6B7280] hover:text-[#111827]"
            >
              <Shield className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" />
              <span className="text-[12px] font-semibold uppercase tracking-wider">Rules · {REVIEW_RULES.length}</span>
              <div className="flex-1" />
              {rulesOpen ? <ChevronDown className="h-3.5 w-3.5 text-[#9CA3AF]" /> : <ChevronRight className="h-3.5 w-3.5 text-[#9CA3AF]" />}
            </button>
            {rulesOpen ? (
              <div className="mt-3 space-y-0.5">
                {REVIEW_RULES.map((r) => {
                  const RuleIcon = r.origin === 'ai' ? Sparkles : User
                  return (
                    <div key={r.id} className="group flex items-start gap-2 rounded px-1 py-1.5 hover:bg-[#F9FAFB]">
                      <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center ${r.origin === 'ai' ? 'text-[#1D9E75]' : 'text-[#9CA3AF]'}`} title={r.origin === 'ai' ? 'AI-generated rule' : 'User-added rule'}>
                        <RuleIcon className="h-3 w-3" />
                      </span>
                      <span className="min-w-0 flex-1 text-[13px] leading-snug text-[#374151]">{r.text}</span>
                      <button
                        type="button"
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#9CA3AF] opacity-0 transition-opacity hover:bg-[#FEF2F2] hover:text-[#EF4444] group-hover:opacity-100"
                        title="Delete rule"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )
                })}
                <button type="button" className="mt-2 inline-flex items-center gap-1 text-[12px] text-[#2358D4] hover:underline">
                  <Plus className="h-2.5 w-2.5" /> Add rule
                </button>
              </div>
            ) : null}
          </section>
        </div>
      )}

      {!historyOpen ? (
        <div className="flex shrink-0 items-center gap-3 border-t border-[#E5E7EB] bg-white px-5 py-3">
          <button
            type="button"
            onClick={onPrev}
            disabled={!hasPrev}
            className={`inline-flex items-center gap-1 text-[13px] ${hasPrev ? 'text-[#6B7280] hover:text-[#111827]' : 'cursor-not-allowed text-[#D1D5DB]'}`}
          >
            <span aria-hidden="true" className="text-[15px] leading-none">‹</span> Prev
          </button>
          <div className="flex-1 text-center text-[12px] tabular-nums text-[#9CA3AF]">
            Field {index + 1} of {total}
          </div>
          <button
            type="button"
            role="checkbox"
            aria-checked={reviewed}
            disabled={!canToggleReviewed}
            onClick={() => {
              if (canToggleReviewed) onSetReviewed(!reviewed)
            }}
            title={canToggleReviewed ? (reviewed ? 'Reviewed' : 'Mark reviewed') : 'Resolve the issue (Fix or Accept) to mark reviewed'}
            className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] ${canToggleReviewed ? 'text-[#374151] hover:text-[#111827]' : 'cursor-not-allowed text-[#9CA3AF]'}`}
          >
            <span
              className="inline-flex h-[15px] w-[15px] items-center justify-center rounded-[3px] border"
              style={{ borderColor: reviewed ? '#16A34A' : '#D1D5DB', background: reviewed ? '#16A34A' : '#FFFFFF', opacity: canToggleReviewed ? 1 : 0.5 }}
            >
              {reviewed ? <Check className="h-[11px] w-[11px] text-white" strokeWidth={3} /> : null}
            </span>
            Reviewed
          </button>
          {isLast ? (
            <span title={!continueAllowed ? `Clear ${blockingLeft} blocker${blockingLeft === 1 ? '' : 's'} to load.` : undefined} className="inline-flex">
              <button
                type="button"
                onClick={onContinue}
                disabled={!continueAllowed}
                className={`inline-flex items-center gap-1.5 rounded-md bg-[#2358D4] px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#1E47B3] ${!continueAllowed ? 'cursor-not-allowed opacity-50' : ''}`}
              >
                Continue to load <ArrowRight className="h-[13px] w-[13px]" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onNext}
              disabled={!hasNext}
              className={`inline-flex items-center gap-1.5 rounded-md bg-[#2358D4] px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#1E47B3] ${!hasNext ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              Next <span aria-hidden="true" className="text-[15px] leading-none">›</span>
            </button>
          )}
        </div>
      ) : null}
    </aside>
  )
}

// ─── All-issues slide-over ("Data quality issues") ───────────────────────────
// Right-edge panel listing every table's flagged fields, optionally scoped to a
// single table. Opened from the issue-summary "Review" (scoped to the current
// table); a row routes to the field-review drawer at its validation block. Esc
// and click-outside close. Mirrors the design's AllIssuesPanel.

function AllIssuesPanel({
  open,
  scopeTable,
  onClose,
  onClearScope,
  onOpenIssue,
}: {
  open: boolean
  scopeTable: string | null
  onClose: () => void
  onClearScope: () => void
  onOpenIssue: (table: string, field: string) => void
}) {
  const ref = useRef<HTMLElement>(null)
  const allTables = ISSUE_GROUPS.map((g) => g.table)
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(allTables))

  // When scoped to a single table, expand that group so its issues are visible.
  useEffect(() => {
    if (open && scopeTable) setOpenGroups((prev) => new Set([...prev, scopeTable]))
  }, [open, scopeTable])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (ref.current && t && ref.current.contains(t)) return
      if (t && t.closest('aside, header, nav, button, [role="button"]')) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    const tid = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.clearTimeout(tid)
    }
  }, [open, onClose])

  if (!open) return null

  const toggleGroup = (table: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(table)) next.delete(table)
      else next.add(table)
      return next
    })

  const scopedGroup = scopeTable ? ISSUE_GROUPS.find((g) => g.table === scopeTable) : null
  const groups = scopedGroup ? [scopedGroup] : ISSUE_GROUPS
  const totalBlocking = groups.reduce((n, g) => n + g.issues.length, 0)

  // The FieldPill carries `{table}.{field}`; the drawer-open path takes the bare
  // field, so strip the table prefix when routing a row.
  const fieldOf = (qualified: string) => qualified.split('.').slice(1).join('.') || qualified

  return (
    <aside
      ref={ref}
      className="fixed top-[100px] right-0 bottom-0 z-30 flex flex-col overflow-hidden border-l border-[#E5E7EB] bg-white shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.08)]"
      style={{ width: 460 }}
      aria-label="Data quality issues"
    >
      <div className="shrink-0 border-b border-[#E5E7EB] px-5 pb-3 pt-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-[#9CA3AF]">Data quality issues</div>
            <div className="mt-2 flex items-center gap-2">
              <Dot kind="blocking" />
              <span className="text-[13.5px] text-[#111827]">
                <span className="font-medium tabular-nums">{totalBlocking}</span> blocking
              </span>
              <span className="text-[#D1D5DB]">·</span>
              <span className="text-[13.5px] text-[#6B7280]">
                <span className="tabular-nums">0</span> warnings
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-0.5 -mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded text-[#9CA3AF] hover:bg-[#F9FAFB] hover:text-[#6B7280]"
            aria-label="Close"
          >
            <X className="h-[15px] w-[15px]" />
          </button>
        </div>
        {scopedGroup && (
          <div className="mt-3 flex items-center gap-2 text-[12.5px]">
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1"
              style={{ borderColor: '#C7D7F5', background: 'rgba(35,88,212,0.06)', color: '#2358D4' }}
            >
              <Filter className="h-[11px] w-[11px]" />
              <span>
                Scoped to <span className="font-mono">{scopeTable}</span>
              </span>
            </span>
            <button type="button" onClick={onClearScope} className="text-[#6B7280] hover:text-[#111827] hover:underline">
              View all tables
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {groups.map((g) => {
          const isOpen = openGroups.has(g.table)
          return (
            <div key={g.table} className="border-b border-[#E5E7EB] last:border-b-0">
              <button
                type="button"
                onClick={() => toggleGroup(g.table)}
                className="flex w-full items-center justify-between gap-3 px-5 py-3 hover:bg-[#F9FAFB]"
              >
                <div className="flex items-center gap-2">
                  {isOpen ? <ChevronDown className="h-[13px] w-[13px] text-[#9CA3AF]" /> : <ChevronRight className="h-[13px] w-[13px] text-[#9CA3AF]" />}
                  <span className="font-mono text-[13px] text-[#111827]">{g.table}</span>
                  <span className="text-[11.5px] text-[#6B7280]">· {g.status}</span>
                </div>
                <div className="text-[12px] tabular-nums text-[#6B7280]">{g.issues.length} blocking</div>
              </button>
              {isOpen && (
                <div className="pb-2">
                  {g.issues.map((iss) => (
                    <button
                      key={iss.id}
                      type="button"
                      onClick={() => onOpenIssue(g.table, fieldOf(iss.field))}
                      className="flex w-full items-start gap-2.5 px-5 py-2.5 text-left hover:bg-[#F9FAFB]"
                    >
                      <Dot kind="blocking" className="mt-1.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <FieldPill>{iss.field}</FieldPill>
                          <span className="text-[11.5px] text-[#6B7280]">{iss.records} records</span>
                          <span className="text-[11.5px] text-[#9CA3AF]">·</span>
                          <span className="text-[11.5px] text-[#6B7280]">{iss.root}</span>
                        </div>
                        <div className="mt-1 text-[12.5px] leading-snug text-[#6B7280]">{iss.desc}</div>
                      </div>
                      <ArrowRight className="mt-1.5 h-[11px] w-[11px] shrink-0 text-[#9CA3AF]" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

// ─── Collapsed data-quality summary line ─────────────────────────────────────

function RtlIssueSummary({
  count,
  issues,
  table,
  onReview,
}: {
  count: number
  issues: RolledIssue[]
  table: string
  onReview: (field: string) => void
}) {
  const [open, setOpen] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const CAP = 5
  if (count === 0) {
    return (
      <div className="rtl-grid-frame mt-4 flex items-center gap-2 bg-white px-4 py-3">
        <Dot kind="ok" size={6} />
        <span className="text-[12.5px] text-[#9CA3AF]">No data quality issues in this table.</span>
      </div>
    )
  }
  const visible = showAll ? issues : issues.slice(0, CAP)
  return (
    <div className="rtl-grid-frame mt-4 overflow-hidden bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-[#FAFAFA]" aria-expanded={open}>
        {open ? <ChevronDown className="h-[13px] w-[13px] text-[#9CA3AF]" /> : <ChevronRight className="h-[13px] w-[13px] text-[#9CA3AF]" />}
        <Dot kind="warning" size={6} />
        <span className="text-[13px] text-[#111827]">
          <span className="font-medium tabular-nums">{count}</span> data quality issue{count === 1 ? '' : 's'} in this table
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3.5">
          <div className="divide-y divide-[#F3F4F6] overflow-hidden rounded-md border border-[#E5E7EB]">
            {visible.map((iss) => {
              const blocking = iss.kind === 'blocking'
              const color = blocking ? '#EF4444' : '#F59E0B'
              const field = iss.column || table
              return (
                <div key={iss.id} className="flex items-center gap-2.5 py-2 pl-3 pr-3 text-[12.5px] hover:bg-[#FAFAFA]" style={{ borderLeft: `2px solid ${color}` }}>
                  <span className="shrink-0 font-mono text-[12px] text-[#111827]">{field}</span>
                  <span className="shrink-0 text-[#D1D5DB]" aria-hidden="true">·</span>
                  <span className="min-w-0 flex-1 truncate text-[#6B7280]">{iss.text}</span>
                  <span className="shrink-0 tabular-nums text-[#9CA3AF]">
                    {iss.records.toLocaleString()} row{iss.records === 1 ? '' : 's'}
                  </span>
                  <button type="button" onClick={() => onReview(field)} className="group inline-flex shrink-0 items-center gap-1 text-[12px] font-medium" style={{ color: '#2358D4' }}>
                    Review
                    <ArrowRight className="h-[11px] w-[11px] transition-transform duration-[120ms] ease-out group-hover:translate-x-0.5" />
                  </button>
                </div>
              )
            })}
          </div>
          {issues.length > CAP && !showAll && (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[12px] font-medium hover:underline" style={{ color: '#2358D4' }}>
              Show all {issues.length}
            </button>
          )}
          {issues.length > CAP && showAll && (
            <button type="button" onClick={() => setShowAll(false)} className="mt-2 text-[12px] font-medium hover:underline" style={{ color: '#2358D4' }}>
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main view (ReadyToLoadView) ─────────────────────────────────────────────

export function MockDataPreview() {
  const [selected, setSelected] = useState('Commodity Codes')
  const [sortBy, setSortBy] = useState<SortBy | null>(null)
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({})
  const [page, setPage] = useState(1)
  const [pending, setPending] = useState<Record<string, Set<string>>>({})
  const [regenerating, setRegenerating] = useState<Record<string, Set<string>>>({})
  const [review, setReview] = useState<ReviewState>({ issues: false, lowConf: false, partition: false })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // Column-focus selection — the focused column keeps its grid focus styling
  // while the review drawer is open on it.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // The review drawer's open field (target column of the selected table). null
  // when the drawer is closed.
  const [openField, setOpenField] = useState<ReviewField | null>(null)
  // Bumped on every (re)open so the drawer body re-runs its scroll positioning;
  // `scrollToIssues` requests the validation block (issue "Review" links).
  const [scrollTick, setScrollTick] = useState(0)
  const [scrollToIssues, setScrollToIssues] = useState(false)
  // Per-field reviewed state — drives the target-row review glyph + progress.
  const [reviewed, setReviewed] = useState<Set<string>>(new Set())
  // Per-field resolution state — a flagged field becomes resolved once its issue
  // is fixed or accepted in the drawer. Drives the Reviewed-checkbox lock + the
  // Continue-to-load gate. Keyed "table|field".
  const [resolved, setResolved] = useState<Set<string>>(new Set())
  // "Data quality issues" slide-over: open flag + the table it's scoped to (null
  // shows every table). The issue-summary "Review" opens it scoped to the current
  // table; a panel row routes into the field-review drawer at its validation.
  const [allIssuesOpen, setAllIssuesOpen] = useState(false)
  const [allIssuesScope, setAllIssuesScope] = useState<string | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  // Keep --rtl-vw in sync with the scroll viewport so full-width partition bands
  // stay pinned to the visible area while the grid scrolls sideways.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const set = () => el.style.setProperty('--rtl-vw', el.clientWidth + 'px')
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => ro.disconnect()
  })

  const isPartitioned = !!READY_PARTITIONS[selected]
  const rawMeta = TABLE_META[selected]
  const fallbackCols = FALLBACK_COLUMNS[selected] || []
  const meta: TableMeta = isPartitioned
    ? { columns: READY_PARTITIONS[selected].columns.map(([key, type]) => ({ key, type })), rows: [], colIssues: {} }
    : rawMeta
      ? rawMeta
      : { columns: fallbackCols.slice(0, 8).map(([key, type]) => ({ key, type })), rows: [], colIssues: {} }

  const currentRows = (DL_TABLES.find((t) => t.name === selected) || { rows: 0 }).rows
  const pendingSet = pending[selected] || new Set<string>()
  const regeneratingSet = regenerating[selected] || new Set<string>()
  const issuesForTable = useMemo(() => rolledIssuesFor(selected, rawMeta || meta), [selected, rawMeta, meta])

  // Reset transient state on table switch. The Issues / Low confidence pills are
  // preserved across tables; only the partition pill (table-specific) clears.
  // The focused column / open drawer are NOT cleared here — Prev/Next crosses
  // table boundaries and must keep the drawer open on the new table. A user
  // table switch via the picker clears them explicitly in onSelect.
  useEffect(() => {
    setSortBy(null)
    setFilters({})
    setReview((r) => ({ issues: r.issues, lowConf: r.lowConf, partition: false }))
    setCollapsed({})
    setPage(1)
  }, [selected])

  const markPendingFor = (table: string, colKey: string) => {
    setPending((prev) => {
      const next = { ...prev }
      const s = new Set(next[table] || [])
      s.add(colKey)
      next[table] = s
      return next
    })
  }

  // Regenerate: brief regenerating state on the affected columns, then clear the
  // stale treatment (values refresh). ~900ms, matching the design.
  const regenerateFor = (table: string, scope: 'col' | 'all' | 'table' | 'pending', colKey?: string) => {
    const cur = pending[table] || new Set<string>()
    const cols = scope === 'col' && colKey ? [colKey] : [...cur]
    if (cols.length === 0) return
    setRegenerating((prev) => {
      const next = { ...prev }
      const s = new Set(next[table] || [])
      cols.forEach((c) => s.add(c))
      next[table] = s
      return next
    })
    setTimeout(() => {
      setRegenerating((prev) => {
        const next = { ...prev }
        const s = new Set(next[table] || [])
        cols.forEach((c) => s.delete(c))
        next[table] = s
        return next
      })
      setPending((prev) => {
        const next = { ...prev }
        const s = new Set(next[table] || [])
        cols.forEach((c) => s.delete(c))
        next[table] = s
        return next
      })
    }, 900)
  }
  const regenerate = (scope: 'col' | 'all' | 'table' | 'pending', colKey?: string) => regenerateFor(selected, scope, colKey)

  const ISS = READY_ISSUES[selected] || {}
  const issueFor = (colKey: string): CellIssue | null => ISS[colKey] || null

  const reviewKey = (table: string, field: string) => `${table}|${field}`
  const reviewedFor = (colKey: string) => reviewed.has(reviewKey(selected, colKey))

  // The review universe = every target field across every table, in order (the
  // field spine the progress counter walks and the drawer Prev/Next steps).
  const reviewUniverse = useMemo<ReviewField[]>(() => {
    const out: ReviewField[] = []
    DL_TABLES.forEach((t) => {
      rtlColumnsForTable(t.name).forEach((c) => out.push({ table: t.name, field: c.key, type: c.type }))
    })
    return out
  }, [])
  const reviewedCount = reviewUniverse.filter((u) => reviewed.has(reviewKey(u.table, u.field))).length

  // A field is flagged-unresolved while it carries a baseline validation entry
  // that hasn't been fixed/accepted — mirrors MockSpecTable's `canToggleReviewed`
  // lock and gates the table's "done" state.
  const flaggedUnresolvedFor = (table: string, field: string) =>
    !!rtlValidationFor(table, field) && !resolved.has(reviewKey(table, field))

  // Tables whose every field is reviewed (drives the picker's all-reviewed glyph).
  const reviewedTables = useMemo(() => {
    const s = new Set<string>()
    DL_TABLES.forEach((t) => {
      const fields = rtlColumnsForTable(t.name).map((c) => c.key)
      if (fields.length && fields.every((f) => reviewed.has(reviewKey(t.name, f)))) s.add(t.name)
    })
    return s
  }, [reviewed])

  // Open the review drawer at a target field — switching the selected table if
  // the field lives elsewhere — and focus its grid column. `toIssues` scrolls the
  // drawer body to the validation block (issue "Review" links).
  const openFieldDrawer = (tgtTable: string, tgtField: string, toIssues = false) => {
    const col = rtlColumnsForTable(tgtTable).find((c) => c.key === tgtField)
    if (tgtTable !== selected) setSelected(tgtTable)
    setSelectedKey(tgtField)
    setScrollToIssues(toIssues)
    setOpenField({ table: tgtTable, field: tgtField, type: col ? col.type : '' })
    setScrollTick((n) => n + 1)
  }

  // Grid column-open: open the drawer at this field (replaces the old visual-only
  // toggle). Re-clicking the focused column closes the drawer.
  const openColumn = (tgtTable: string, tgtField: string) => {
    if (openField && openField.table === tgtTable && openField.field === tgtField) {
      closeDrawer()
      return
    }
    openFieldDrawer(tgtTable, tgtField)
  }

  // Flagged-cell alert (red/amber triangle): open the drawer at this field
  // scrolled to its validation block. Parallels `openColumn`, always to-issues.
  const openColumnIssues = (tgtTable: string, tgtField: string) => openFieldDrawer(tgtTable, tgtField, true)

  // Issue-summary "Review": open the slide-over scoped to the given table.
  const openAllIssues = (table: string) => {
    setAllIssuesScope(table)
    setAllIssuesOpen(true)
  }

  const closeDrawer = () => {
    setOpenField(null)
    setSelectedKey(null)
    setScrollToIssues(false)
  }

  const toggleReviewed = (table: string, field: string, val: boolean) =>
    setReviewed((prev) => {
      const k = reviewKey(table, field)
      const next = new Set(prev)
      if (val) next.add(k)
      else next.delete(k)
      return next
    })

  const setFieldResolved = (table: string, field: string, val: boolean) =>
    setResolved((prev) => {
      const k = reviewKey(table, field)
      if (prev.has(k) === val) return prev
      const next = new Set(prev)
      if (val) next.add(k)
      else next.delete(k)
      return next
    })

  // "Review fields" / "Resume" — open the drawer at the first field that still
  // needs review (the design opens the field rather than just marking it).
  const startReview = () => {
    const next = reviewUniverse.find((u) => !reviewed.has(reviewKey(u.table, u.field))) || reviewUniverse[0]
    if (!next) return
    openFieldDrawer(next.table, next.field)
  }

  // Drawer Prev/Next step the spine, crossing table boundaries.
  const openIndex = openField ? reviewUniverse.findIndex((u) => u.table === openField.table && u.field === openField.field) : -1
  const stepDrawer = (dir: 'prev' | 'next') => {
    if (openIndex < 0) return
    const ni = dir === 'next' ? openIndex + 1 : openIndex - 1
    if (ni < 0 || ni >= reviewUniverse.length) return
    const target = reviewUniverse[ni]
    openFieldDrawer(target.table, target.field)
  }

  // Continue-to-load gate: no unresolved blocking field anywhere in the spine.
  const blockingLeft = reviewUniverse.filter((u) => {
    const v = rtlValidationFor(u.table, u.field)
    return !!v && v.sev === 'blocking' && !resolved.has(reviewKey(u.table, u.field))
  }).length

  const pendingCount = pendingSet.size

  const dataRows = useMemo(() => {
    if (isPartitioned) return []
    return applyTableFilterSort(meta.rows || [], meta.columns || [], filters, sortBy)
  }, [isPartitioned, meta, filters, sortBy])

  // "Issues" restricts displayed data rows to rows with at least one flagged cell.
  const flaggedRowIdx = useMemo(() => {
    if (!review.issues || isPartitioned) return null
    const set = new Set<number>()
    Object.values(ISS).forEach((info) => (info.rows || []).forEach((r) => set.add(r)))
    return set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review.issues, isPartitioned, selected])

  return (
    <div style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"' }}>
      <style>{`
        .rtl-stale { background-image: repeating-linear-gradient(45deg, rgba(148,163,184,0.10) 0 6px, transparent 6px 12px) !important; }
        .rtl-cell-stale { opacity: 0.5; }
        @keyframes rtlRegenPulse { 0%, 100% { opacity: 0.28; } 50% { opacity: 0.6; } }
        .rtl-cell-regen { animation: rtlRegenPulse 0.85s ease-in-out infinite; }
        @keyframes rtlSpin { to { transform: rotate(360deg); } }
        .rtl-spin { animation: rtlSpin 0.8s linear infinite; }
        .rtl-grid-wrap { --rtl-tint: #F3F4F6; --color-border-tertiary: #F3F4F6; --color-background-secondary: #FFFFFF; --color-border-secondary: #E5E7EB; --color-background-warning: #FFFBEB; }
        .rtl-grid-frame { border: 1px solid #E5E7EB; border-radius: 8px; }
        .rtl-divider   { border-bottom: 0.5px solid var(--color-border-secondary); }
        .rtl-underhead { border-bottom: 1px solid #D4D4D8; }
        .rtl-rowline   { border-bottom: 0.5px solid var(--color-border-tertiary); }
        .rtl-rowline:last-child { border-bottom: 0; }
        .rtl-lane { border-right: 0; }
        .rtl-dim { opacity: 0.4; transition: opacity 150ms ease; }
      `}</style>

      {/* Toolbar zone — sits directly on the off-white page above the table */}
      <div className="mb-3 flex flex-nowrap items-center gap-3 py-2.5">
        <TablePicker
          tables={DL_TABLES}
          selected={selected}
          onSelect={(name) => {
            closeDrawer()
            setSelected(name)
          }}
          currentRows={currentRows}
          reviewedTables={reviewedTables}
        />

        <div className="inline-flex shrink-0 items-center gap-1.5">
          <RtlChip active={review.issues} onClick={() => setReview((r) => ({ ...r, issues: !r.issues }))}>
            <AlertTriangle className="h-3 w-3" />
            Issues
          </RtlChip>
          <RtlTip label="Below 90% confidence">
            <RtlChip active={review.lowConf} onClick={() => setReview((r) => ({ ...r, lowConf: !r.lowConf }))}>
              <span className="inline-block shrink-0 rounded-full" style={{ width: 6, height: 6, background: '#d97706' }} />
              Low confidence
            </RtlChip>
          </RtlTip>
          {isPartitioned && (
            <RtlChip active={review.partition} onClick={() => setReview((r) => ({ ...r, partition: !r.partition }))}>
              By partition
            </RtlChip>
          )}
        </div>

        <div className="min-w-0 flex-1" />

        {pendingCount > 0 && <RtlRegenerate count={pendingCount} onRegen={(k) => regenerate(k === 'pending' ? 'pending' : 'table')} />}

        <ReviewProgressCTA reviewedCount={reviewedCount} total={reviewUniverse.length} onStart={startReview} />
      </div>

      {/* Active filter chips */}
      {Object.keys(filters).length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {Object.entries(filters).map(([colKey, f]) => (
            <span key={colKey} className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E7EB] bg-white px-2 py-0.5 text-[11.5px] text-[#374151]">
              <span className="font-mono text-[#111827]">{colKey}:</span>
              <span className="max-w-[180px] truncate">{filterExpressionLabel(f)}</span>
              <button
                onClick={() =>
                  setFilters((prev) => {
                    const n = { ...prev }
                    delete n[colKey]
                    return n
                  })
                }
                className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[#9CA3AF] hover:bg-[#F3F4F6] hover:text-[#6B7280]"
                aria-label={`Remove ${colKey} filter`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          <div className="flex-1" />
          <button onClick={() => setFilters({})} className="shrink-0 text-[11.5px] text-[#3B82F6] hover:underline">
            Clear all filters
          </button>
        </div>
      )}

      {/* Partition summary line */}
      {isPartitioned && (
        <div className="mb-3 flex items-center gap-2 text-[12px] text-[#6B7280]">
          <Layers className="h-[13px] w-[13px] text-[#9CA3AF]" />
          <span>
            {READY_PARTITIONS[selected].summary.partitions} partitions · {READY_PARTITIONS[selected].summary.order} · {READY_PARTITIONS[selected].summary.rows.toLocaleString()} rows ·{' '}
            {READY_PARTITIONS[selected].summary.deduped} deduped against earlier partitions
          </span>
        </div>
      )}

      {/* Table card + review drawer — the drawer is an absolute overlay bracketed
          to this relative container, mirroring the design's target-lens layout.
          --rtl-drawer-top/fill anchor the overlay to the card top with a measured
          fallback height. */}
      <div
        className="relative"
        style={{ ['--rtl-drawer-top' as string]: '0px', ['--rtl-drawer-fill' as string]: 'calc(100vh - 220px)' }}
      >
      {/* Table card — bold frame; the pagination row lives INSIDE it as a footer. */}
      <div className="rtl-grid-frame overflow-hidden bg-white">
        <div className="rtl-grid-wrap overflow-auto" ref={wrapRef} style={{ maxHeight: isPartitioned ? undefined : 560 }}>
          {isPartitioned ? (
            <RtlPartitionedGrid
              table={selected}
              meta={meta}
              pendingSet={pendingSet}
              regeneratingSet={regeneratingSet}
              collapsed={collapsed}
              selectedKey={selectedKey}
              onToggle={(id) => setCollapsed((c) => ({ ...c, [id]: !c[id] }))}
              onOpenColumn={openColumn}
              onOpenColumnIssues={openColumnIssues}
              onRegenerateCol={(c) => regenerate('col', c)}
              sortBy={sortBy}
              filters={filters}
              onSetSort={setSortBy}
              onClearSort={() => setSortBy(null)}
              onSetFilter={(k, f) => setFilters((p) => ({ ...p, [k]: f }))}
              onClearFilter={(k) =>
                setFilters((p) => {
                  const n = { ...p }
                  if (k) delete n[k]
                  return n
                })
              }
            />
          ) : (
            <RtlSingleGrid
              table={selected}
              meta={meta}
              rows={dataRows}
              flaggedRowIdx={flaggedRowIdx}
              lowConf={review.lowConf}
              pendingSet={pendingSet}
              regeneratingSet={regeneratingSet}
              issueFor={issueFor}
              selectedKey={selectedKey}
              reviewedFor={reviewedFor}
              onOpenColumn={openColumn}
              onOpenColumnIssues={openColumnIssues}
              onRegenerateCol={(c) => regenerate('col', c)}
            />
          )}
        </div>

        {/* Pagination footer (single-partition) — inside the card */}
        {!isPartitioned &&
          (() => {
            const pageSize = 10
            const totalPages = Math.max(1, Math.ceil(currentRows / pageSize))
            const start = currentRows === 0 ? 0 : (page - 1) * pageSize + 1
            const end = Math.min(page * pageSize, currentRows)
            return (
              <div className="flex items-center justify-between px-5 py-2.5 text-[12px] text-[#6B7280]" style={{ borderTop: '0.5px solid #E5E7EB' }}>
                <div>
                  Showing <span className="tabular-nums text-[#111827]">{start}–{end}</span> of <span className="tabular-nums text-[#111827]">{currentRows.toLocaleString()}</span> rows
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={page === 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-[12px] font-medium text-[#6B7280] transition-colors hover:bg-[#F9FAFB] disabled:opacity-50"
                  >
                    <ChevronLeft className="h-3 w-3" />
                    Prev
                  </button>
                  {rtlPageItems(page, totalPages).map((it, i) =>
                    it === '…' ? (
                      <span key={`e${i}`} className="inline-flex h-[26px] min-w-[26px] select-none items-center justify-center text-[#9CA3AF]">
                        {it}
                      </span>
                    ) : (
                      <button
                        key={it}
                        type="button"
                        onClick={() => setPage(it)}
                        aria-current={it === page ? 'page' : undefined}
                        className={`inline-flex h-[26px] min-w-[26px] items-center justify-center rounded-md px-1.5 text-[12px] font-medium tabular-nums transition-colors ${it === page ? 'text-white' : 'text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111827]'}`}
                        style={it === page ? { background: '#2358D4' } : undefined}
                      >
                        {it}
                      </button>
                    ),
                  )}
                  <button
                    type="button"
                    disabled={page === totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-[12px] font-medium text-[#6B7280] transition-colors hover:bg-[#F9FAFB] disabled:opacity-50"
                  >
                    Next
                    <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )
          })()}

        {/* Partitioned footer — inside the card */}
        {isPartitioned && (
          <div className="flex items-center justify-between px-5 py-2.5 text-[12px]" style={{ borderTop: '0.5px solid #E5E7EB' }}>
            <button className="inline-flex items-center gap-1.5 hover:underline" style={{ color: '#2358D4' }}>
              <Plus className="h-3 w-3" /> Add partition
            </button>
            <span className="text-[#9CA3AF]">Grouped by partition</span>
          </div>
        )}
      </div>

        {openField && openIndex >= 0 ? (
          <DataPreviewReviewDrawer
            key={`${openField.table}|${openField.field}`}
            table={openField.table}
            field={openField.field}
            type={openField.type}
            index={openIndex}
            total={reviewUniverse.length}
            isLast={openIndex === reviewUniverse.length - 1}
            continueAllowed={blockingLeft === 0}
            blockingLeft={blockingLeft}
            reviewed={reviewed.has(reviewKey(openField.table, openField.field))}
            flaggedUnresolved={flaggedUnresolvedFor(openField.table, openField.field)}
            initiallyResolved={resolved.has(reviewKey(openField.table, openField.field))}
            scrollTick={scrollTick}
            scrollToIssues={scrollToIssues}
            hasPrev={openIndex > 0}
            hasNext={openIndex < reviewUniverse.length - 1}
            onSetReviewed={(val) => toggleReviewed(openField.table, openField.field, val)}
            onSetResolved={(val) => setFieldResolved(openField.table, openField.field, val)}
            onPrev={() => stepDrawer('prev')}
            onNext={() => stepDrawer('next')}
            onContinue={closeDrawer}
            onClose={closeDrawer}
          />
        ) : null}
      </div>

      {/* Bottom data-quality strip */}
      <RtlIssueSummary
        count={issuesForTable.length}
        issues={issuesForTable}
        table={selected}
        onReview={() => openAllIssues(selected)}
      />

      <AllIssuesPanel
        open={allIssuesOpen}
        scopeTable={allIssuesScope}
        onClose={() => {
          setAllIssuesOpen(false)
          setAllIssuesScope(null)
        }}
        onClearScope={() => setAllIssuesScope(null)}
        onOpenIssue={(table, field) => {
          openFieldDrawer(table, field, true)
          setAllIssuesOpen(false)
          setAllIssuesScope(null)
        }}
      />
    </div>
  )
}
