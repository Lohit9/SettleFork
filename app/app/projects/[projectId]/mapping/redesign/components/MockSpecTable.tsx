'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ArrowRight,
  CornerDownRight,
  Sparkles,
  Clock,
  MoreHorizontal,
  X,
  Pencil,
  Check,
  Shield,
  BookOpen,
  Trash2,
  User,
  Cpu,
  Plus,
  AlertTriangle,
  Code,
  Play,
  Wrench,
  RefreshCw,
  Loader2,
  Layers,
  Search,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// MOCK — Settle MVP "Map & Transform" spec table (src/screen-configure.jsx).
// Hardcoded design data so the Configure surface matches the design ahead of
// real data wiring. The row-click drawer is interactive (edit mode, transform
// editor, dry-run validation with Fix/Accept, per-field Reviewed state); the
// underlying mappings are still mock, so edits and fixes are not persisted.
// ─────────────────────────────────────────────────────────────────────────────

const GRID =
  'grid grid-cols-[220px_14px_220px_minmax(200px,1fr)_minmax(220px,260px)_90px] gap-4 items-center pl-[38px] pr-6'

interface ExtraSource {
  table: string
  field: string
  note: string
}

interface MappedMock {
  srcTable: string
  srcField: string
  extraSources?: ExtraSource[]
  tgtTable: string
  tgtField: string
  transform: string
  rationale: string
  confidence: number
  issue?: { tone: 'red' | 'amber'; count: number; heading?: string; samples?: string[] }
}

const SRC_TYPE: Record<string, string> = {
  ASSY_ITEM: 'VARCHAR(20)',
  COMM_HINT: 'VARCHAR(12)',
  PRODUCT_NAME: 'VARCHAR(100)',
  REV: 'VARCHAR(8)',
  ACTIVE_FLG: 'VARCHAR(1)',
  CLASS_CD: 'VARCHAR(8)',
  COMM_CD: 'VARCHAR(20)',
  COMM_DESC: 'VARCHAR(100)',
  GL_ACCT: 'VARCHAR(20)',
}

const TGT_TYPE: Record<string, string> = {
  item_number: 'VARCHAR(50)',
  commodity_code: 'VARCHAR(20)',
  item_description: 'VARCHAR(100)',
  revision: 'VARCHAR(8)',
  is_active: 'BOOLEAN',
  commodity_class: 'VARCHAR(40)',
  description: 'VARCHAR(100)',
  default_gl_account: 'VARCHAR(20)',
}

const RATIONALE_PROSE: Record<string, string> = {
  ASSY_ITEM: 'Source ASSY_ITEM represents the same identifier as target item_number, matched by semantic role. Pass-through after trim and uppercase.',
  COMM_HINT: 'Target commodity_code is inferred from the COMM_HINT token via a lookup against Commodity Codes. 41 items carry a hint with no matching commodity, which blocks the column from loading.',
  PRODUCT_NAME: 'Target item_description is derived from COALESCE(ProductName, Assy Desc). When ProductName is null the description falls back to Assy Desc; the fallback path lowers confidence.',
  REV: 'Source REV maps to target revision on semantic role and type.',
  ACTIVE_FLG: "Source ACTIVE_FLG is a Y/N flag; target is_active is boolean. Cast via CASE WHEN ACTIVE_FLG = 'Y' THEN true ELSE false END.",
  CLASS_CD: 'Source CLASS_CD holds short class codes (FG, RM, WIP). Each maps to a canonical commodity_class via the class_map lookup table. 2 unmapped codes need review.',
  COMM_CD: 'Source COMM_CD and target commodity_code share the same natural key — a short alphanumeric commodity identifier. Direct pass-through with no transform.',
  COMM_DESC: 'Source COMM_DESC carries the human-readable description for each commodity. Semantic match to description; a leading/trailing whitespace trim is suggested.',
  GL_ACCT: 'Source GL_ACCT holds abbreviated GL codes (e.g. 5100-MFG). Target default_gl_account expects full account numbers. Resolved via gl_map lookup table.',
}

const MAPPED: MappedMock[] = [
  { srcTable: 'BOM_MASTERS', srcField: 'ASSY_ITEM', tgtTable: 'Engineering Item Master', tgtField: 'item_number', transform: 'No Transform · suggested: no transform', rationale: 'Direct match', confidence: 97 },
  { srcTable: 'BOM_MASTERS', srcField: 'COMM_HINT', tgtTable: 'Engineering Item Master', tgtField: 'commodity_code', transform: 'Applied · Commodity lookup', rationale: 'Inferred', confidence: 71, issue: { tone: 'red', count: 41, heading: 'Hint has no matching commodity', samples: ['CMP-X12', 'LEG-0098', 'TMP-5523', 'OBS-1190'] } },
  { srcTable: 'BOM_MASTERS', srcField: 'PRODUCT_NAME', extraSources: [{ table: 'BOM_MASTERS', field: 'ASSY_DESC', note: 'Fallback when ProductName is null' }], tgtTable: 'Engineering Item Master', tgtField: 'item_description', transform: 'Draft · COALESCE name fallback', rationale: 'Multi-source', confidence: 84, issue: { tone: 'amber', count: 12, heading: 'ProductName null — fell back to Assy Desc', samples: ['(null) → PUMP ASSY 4IN', '(null) → VALVE BODY', '(null) → GASKET KIT'] } },
  { srcTable: 'BOM_MASTERS', srcField: 'REV', tgtTable: 'Engineering Item Master', tgtField: 'revision', transform: 'No Transform · suggested: no transform', rationale: 'Direct match', confidence: 96 },
  { srcTable: 'COMMODITY_MASTER', srcField: 'ACTIVE_FLG', tgtTable: 'Commodity Codes', tgtField: 'is_active', transform: 'Applied · Cast Y/N to boolean', rationale: 'Semantic match', confidence: 98 },
  { srcTable: 'COMMODITY_MASTER', srcField: 'CLASS_CD', tgtTable: 'Commodity Codes', tgtField: 'commodity_class', transform: 'Applied · Map class codes (6)', rationale: 'Lookup via class_map', confidence: 86 },
  { srcTable: 'COMMODITY_MASTER', srcField: 'COMM_CD', tgtTable: 'Commodity Codes', tgtField: 'commodity_code', transform: 'No Transform · suggested: no transform', rationale: 'Direct match', confidence: 99 },
  { srcTable: 'COMMODITY_MASTER', srcField: 'COMM_DESC', tgtTable: 'Commodity Codes', tgtField: 'description', transform: 'No Transform · suggested: Trim whitespace', rationale: 'Semantic match', confidence: 100 },
  { srcTable: 'COMMODITY_MASTER', srcField: 'GL_ACCT', tgtTable: 'Commodity Codes', tgtField: 'default_gl_account', transform: 'Draft · Lookup GL via gl_map', rationale: 'Lookup via gl_map', confidence: 88 },
]

const UNMAPPED_TARGETS = [
  { tgtTable: 'Engineering Item Master', tgtField: 'lot_controlled', tag: 'Default: false', action: 'Set value' },
  { tgtTable: 'Commodity Codes', tgtField: 'created_by', tag: 'System default', action: 'Set value' },
  { tgtTable: 'Customer', tgtField: 'credit_hold', tag: 'Needs source', action: 'Add source' },
  { tgtTable: 'Product', tgtField: 'discontinued_date', tag: 'Will load empty', action: 'Add source' },
  { tgtTable: 'Work Center', tgtField: 'cost_center', tag: 'Needs source', action: 'Add source' },
  { tgtTable: 'Routing', tgtField: 'std_batch_qty', tag: 'Default value', action: 'Set value' },
  { tgtTable: 'Bill of Materials', tgtField: 'effectivity_date', tag: 'Will load empty', action: 'Exclude' },
]

const UNMAPPED_SOURCE = [
  { srcTable: 'COMMODITY_MASTER', srcField: 'SAFETY_STOCK', tag: 'Out of scope' },
  { srcTable: 'COMMODITY_MASTER', srcField: 'REORDER_PT', tag: 'Out of scope' },
  { srcTable: 'PRODUCT_MASTER', srcField: 'LIST_PRICE', tag: 'No target match' },
  { srcTable: 'WORKCENTER', srcField: 'SHIFT_CT', tag: 'Out of scope' },
  { srcTable: 'BOM_LINES', srcField: 'REF_DES', tag: 'No target match' },
  { srcTable: 'BOM_MASTERS', srcField: 'LEGACY_CODE', tag: 'Out of scope' },
  { srcTable: 'PRODUCT_MASTER', srcField: 'OLD_LIST_PRICE', tag: 'Deprecated field' },
  { srcTable: 'CUST_MASTER', srcField: 'SALES_REGION', tag: 'No target match' },
]

// Searchable catalog of source fields, grouped by source table — backs the
// source-field picker (matches the design's SOURCE_FIELD_CATALOG / BadgePicker).
const SOURCE_FIELD_CATALOG: Record<string, string[]> = {
  BOM_MASTERS: ['ASSY_ITEM', 'COMM_HINT', 'PRODUCT_NAME', 'ASSY_DESC', 'REV', 'LEGACY_CODE'],
  COMMODITY_MASTER: ['ACTIVE_FLG', 'CLASS_CD', 'COMM_CD', 'COMM_DESC', 'GL_ACCT', 'SAFETY_STOCK', 'REORDER_PT'],
  PRODUCT_MASTER: ['STAT', 'LIST_PRICE', 'OLD_LIST_PRICE'],
  WORKCENTER: ['SHIFT_CT', 'COST_CENTER'],
  BOM_LINES: ['REF_DES', 'QTY_PER'],
  CUST_MASTER: ['ADDR_1', 'SALES_REGION', 'CREDIT_HOLD'],
}

const TARGET_FIELD_CATALOG: Record<string, string[]> = {
  'Engineering Item Master': ['item_number', 'commodity_code', 'item_description', 'revision', 'lot_controlled'],
  'Commodity Codes': ['is_active', 'commodity_class', 'commodity_code', 'description', 'default_gl_account', 'created_by'],
  Customer: ['address_line1', 'credit_hold'],
  Product: ['status', 'discontinued_date'],
  'Work Center': ['cost_center'],
  Routing: ['std_batch_qty'],
  'Bill of Materials': ['effectivity_date'],
}

function FieldPill({ children, noTruncate = false }: { children: React.ReactNode; noTruncate?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[3px] font-mono text-[12px] text-[#111827] ${noTruncate ? 'shrink-0 whitespace-nowrap' : 'truncate'}`}
    >
      {children}
    </span>
  )
}

// Source-field search popover. Portaled to <body> with fixed positioning so it
// is never clipped by the table card's overflow. Mirrors the design's
// BadgePicker (search box + per-table groups). onClose on scroll/resize.
function FieldPicker({
  side,
  pos,
  currentTable,
  currentField,
  onPick,
  onClose,
}: {
  side: 'source' | 'target'
  pos: { top: number; left: number }
  currentTable: string
  currentField: string
  onPick: (table: string, field: string) => void
  onClose: () => void
}) {
  const catalog = side === 'source' ? SOURCE_FIELD_CATALOG : TARGET_FIELD_CATALOG
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const qq = q.trim().toLowerCase()
  return createPortal(
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top: pos.top, left: pos.left }}
      className="z-50 flex max-h-[380px] w-[320px] flex-col overflow-hidden rounded-lg border border-[#E5E7EB] bg-white shadow-[0_8px_24px_-6px_rgba(17,24,39,0.12)]"
    >
      <div className="border-b border-[#E5E7EB] p-2.5">
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[#9CA3AF]">
            <Search className="h-3 w-3" />
          </span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={side === 'source' ? 'Search source fields…' : 'Search target fields…'}
            className="w-full rounded-md border border-[#E5E7EB] bg-white py-1.5 pl-7 pr-2 text-[12.5px] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
          />
        </div>
      </div>
      <div className="overflow-y-auto py-1">
        {Object.keys(catalog).map((tbl) => {
          const fields = catalog[tbl].filter(
            (f) => !qq || tbl.toLowerCase().includes(qq) || f.toLowerCase().includes(qq),
          )
          if (fields.length === 0) return null
          return (
            <div key={tbl} className="py-1">
              <div className="px-3 pb-1 pt-1 font-mono text-[10.5px] uppercase tracking-wider text-[#9CA3AF]">
                {tbl}
              </div>
              {fields.map((f) => {
                const isCurrent = tbl === currentTable && f === currentField
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => {
                      onPick(tbl, f)
                      onClose()
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-[#F9FAFB] ${isCurrent ? 'bg-[#F9FAFB]' : ''}`}
                  >
                    <FieldPill>{f}</FieldPill>
                    {isCurrent ? (
                      <span className="shrink-0 text-[11px] italic text-[#9CA3AF]">current</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

// Clickable source-field badge that opens the search picker. Shows the full
// field name (no truncation); the swap is visual-only, matching the design.
function EditableFieldBadge({ side, table, field }: { side: 'source' | 'target'; table: string; field: string }) {
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState({ table, field })
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setSel({ table, field })
  }, [table, field])

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: r.left })
    setOpen((o) => !o)
  }

  return (
    <span className="relative inline-flex shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[3px] font-mono text-[12px] text-[#111827] hover:bg-[#E5E7EB]"
      >
        {sel.field}
      </button>
      {open && pos ? (
        <FieldPicker
          side={side}
          pos={pos}
          currentTable={sel.table}
          currentField={sel.field}
          onPick={(t, f) => setSel({ table: t, field: f })}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  )
}

function SystemName({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11.5px] text-[#9CA3AF] truncate">{children}</span>
}

function Placeholder({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-dashed border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[3px] text-[12px] text-[#9CA3AF] whitespace-nowrap">
      <span className="h-[5px] w-[5px] shrink-0 rounded-full bg-[#9CA3AF]" />
      {label}
    </span>
  )
}

function ReviewGlyph({ reviewed = false }: { reviewed?: boolean }) {
  if (reviewed) {
    return (
      <svg
        viewBox="0 0 20 20"
        className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
        role="img"
        aria-label="Reviewed"
      >
        <circle cx="10" cy="10" r="8.25" fill="none" stroke="#16A34A" strokeWidth="1.5" />
        <path
          d="M6.2 10.4 L8.7 12.9 L13.9 7.3"
          fill="none"
          stroke="#16A34A"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <span className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-full border border-dashed border-[#D1D5DB]" />
  )
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[3px] text-[12px] text-[#6B7280] whitespace-nowrap">
      <span className="truncate max-w-[150px]">{children}</span>
    </span>
  )
}

function RationalePopover({ rationale, confidence, srcField }: { rationale: string; confidence: number; srcField: string }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prose = RATIONALE_PROSE[srcField] ?? ''

  const handleMouseEnter = () => {
    timer.current = setTimeout(() => setOpen(true), 300)
  }
  const handleMouseLeave = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setOpen(false)
  }

  return (
    <div className="relative flex min-w-0 items-center gap-1.5" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <span className="inline-flex cursor-default items-center gap-1.5 rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[3px] text-[12px] whitespace-nowrap">
        <span className="truncate max-w-[150px] text-[#374151]">{rationale}</span>
        <span className="text-[#9CA3AF] tabular-nums">· {confidence}%</span>
        <ChevronDown className="h-3 w-3 text-[#9CA3AF]" />
      </span>
      {open && prose ? (
        <div className="pointer-events-none absolute top-full left-0 z-50 mt-2 w-[340px] rounded-lg border border-[#E5E7EB] bg-white p-4 shadow-lg">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#374151]">
              {rationale}
            </span>
            <span className="text-[12px] text-[#9CA3AF] tabular-nums">· {confidence}%</span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-[#4B5563]">{prose}</p>
        </div>
      ) : null}
    </div>
  )
}

interface VersionEntry {
  who: string
  kind: 'user' | 'fix' | 'system'
  relative: string
  when: string
  summary: string
  before: string
  after: string
}

const RULES: { id: string; origin: 'ai' | 'user'; text: string }[] = [
  { id: 'r1', origin: 'ai', text: 'Value must be present after transform; null loads are flagged.' },
  { id: 'r2', origin: 'ai', text: 'Trim leading and trailing whitespace before load.' },
  { id: 'r3', origin: 'user', text: "Skip rows where the source key matches 'TEST-*'." },
]

const VERSION_ENTRIES: VersionEntry[] = [
  { who: 'Kaan Dincer', kind: 'user', relative: '1 hour ago', when: 'May 23, 5:14 PM', summary: 'Transform applied', before: '— (draft)', after: "'ACCT-' || ACCT_NO" },
  { who: 'Kaan Dincer', kind: 'fix', relative: '3 hours ago', when: 'May 23, 3:01 PM', summary: "Fix applied: SQL parse error — added 'ACCT-' prefix to BRANCH_NO transform", before: 'BRANCH_NO transform failed: missing prefix', after: "'ACCT-' || BRANCH_NO" },
  { who: 'System', kind: 'system', relative: '1 day ago', when: 'May 22, 4:32 PM', summary: 'Transform validated against sample (412 rows)', before: '0 / 412 sampled', after: '412 / 412 passed validation' },
  { who: 'Kaan Dincer', kind: 'user', relative: '1 day ago', when: 'May 22, 4:18 PM', summary: 'Edited transform — added ACCT- prefix to source value', before: 'ACCT_NO', after: "'ACCT-' || ACCT_NO" },
  { who: 'Kaan Dincer', kind: 'fix', relative: '2 days ago', when: 'May 21, 11:48 AM', summary: 'Fix applied: Type mismatch — cast OPEN_DT VARCHAR to DATE before mapping', before: 'OPEN_DT VARCHAR(10) → opened_date DATE failed cast', after: "TO_DATE(OPEN_DT, 'YYYY-MM-DD') AS opened_date" },
  { who: 'System', kind: 'system', relative: '2 days ago', when: 'May 21, 9:02 AM', summary: 'Generated transform: pass-through direct map', before: '— (no transform)', after: 'ACCT_NO' },
]

function VersionHistoryView({ onBack }: { onBack: () => void }) {
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
        <span className="ml-1 text-[11.5px] tabular-nums text-[#9CA3AF]">{VERSION_ENTRIES.length} entries</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {VERSION_ENTRIES.map((e, i) => {
          const open = expanded.has(i)
          const badgeClass =
            e.kind === 'system'
              ? 'text-[#6B7280] border-[#E5E7EB] bg-[#F9FAFB]'
              : e.kind === 'fix'
                ? 'text-[#047857] border-[#A7F3D0] bg-[#ECFDF5]'
                : 'text-[#1D4ED8] border-[#DBEAFE] bg-[#EFF6FF]'
          const BadgeIcon = e.kind === 'system' ? Cpu : e.kind === 'fix' ? Sparkles : User
          return (
            <div key={i} className={`px-5 py-3 ${i !== VERSION_ENTRIES.length - 1 ? 'border-b border-[#E5E7EB]' : ''}`}>
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

interface FieldProfile {
  distinct: number
  nullRate: number
  length: { min: number; max: number; avg: number }
  mostCommon: string
  samples: { value: string; row: number }[]
  top: { value: string; count: number; pct: number }[]
}

const TARGET_PROFILE: FieldProfile = {
  distinct: 212,
  nullRate: 0,
  length: { min: 5, max: 7, avg: 5.7 },
  mostCommon: 'P-DWS',
  samples: [
    { value: 'P-DWS', row: 286 },
    { value: 'P-WHC08', row: 572 },
    { value: 'WHC08', row: 41 },
  ],
  top: [
    { value: 'P-DWS', count: 44, pct: 2.1 },
    { value: 'P-WHC08', count: 33, pct: 1.6 },
    { value: 'WHC08', count: 25, pct: 1.2 },
  ],
}

const SOURCE_PROFILE: FieldProfile = {
  distinct: 57,
  nullRate: 12.4,
  length: { min: 4, max: 6, avg: 5.2 },
  mostCommon: 'P-DWS',
  samples: [
    { value: 'P-DWS', row: 24 },
    { value: 'P-WHC08', row: 91 },
    { value: 'WHC08', row: 7 },
  ],
  top: [
    { value: 'P-DWS', count: 18, pct: 5.4 },
    { value: 'P-WHC08', count: 14, pct: 4.2 },
    { value: 'WHC08', count: 11, pct: 3.3 },
  ],
}

function GlossaryStat({
  label,
  value,
  sub,
  mono,
}: {
  label: string
  value: string
  sub?: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-[#9CA3AF]">{label}</div>
      <div className={`mt-1 truncate text-[13px] text-[#111827] ${mono ? 'font-mono' : ''}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-[#9CA3AF]">{sub}</div> : null}
    </div>
  )
}

function GlossaryProfileBlock({
  role,
  field,
  type,
  profile,
}: {
  role: string
  field: string
  type: string
  profile: FieldProfile
}) {
  const maxPct = profile.top.length ? Math.max(...profile.top.map((t) => t.pct)) : 1
  return (
    <div className="border-b border-[#E5E7EB] px-5 py-5 last:border-b-0">
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#6B7280]">{role}</span>
        <FieldPill>{field}</FieldPill>
        <span className="font-mono text-[11px] text-[#9CA3AF]">{type}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        <GlossaryStat label="Distinct" value={profile.distinct.toLocaleString()} />
        <GlossaryStat label="Null rate" value={`${profile.nullRate}%`} />
        <GlossaryStat label="Length" value={`${profile.length.min}–${profile.length.max}`} sub={`avg ${profile.length.avg}`} />
        <GlossaryStat label="Most common" value={profile.mostCommon} mono />
      </div>

      <div className="mt-5">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">Sample values</span>
          <span className="text-[11px] tabular-nums text-[#9CA3AF]">
            {profile.samples.length} of {profile.distinct.toLocaleString()}
          </span>
        </div>
        <div className="mt-2 space-y-1">
          {profile.samples.map((s, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <span className="truncate rounded border border-[#E5E7EB] bg-[#F9FAFB] px-2 py-1 font-mono text-[12px] text-[#111827]">
                {s.value}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[#9CA3AF]">row {s.row}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">Top values</span>
        <div className="mt-2 space-y-2">
          {profile.top.map((t, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="w-[110px] truncate font-mono text-[12px] text-[#111827]">{t.value}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#F3F4F6]">
                <div className="h-full bg-[#D1D5DB]" style={{ width: `${Math.max(6, (t.pct / maxPct) * 100)}%` }} />
              </div>
              <span className="w-[78px] shrink-0 text-right text-[11px] tabular-nums text-[#6B7280]">
                {t.count.toLocaleString()} · {t.pct}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function GlossaryView({
  row,
  onBack,
  onClose,
}: {
  row: MappedMock
  onBack: () => void
  onClose: () => void
}) {
  const tgtType = TGT_TYPE[row.tgtField] ?? 'VARCHAR(50)'
  const srcType = SRC_TYPE[row.srcField] ?? 'VARCHAR(20)'
  return (
    <aside
      aria-label="Glossary"
      className="fixed bottom-0 right-0 top-[100px] z-50 flex w-[440px] flex-col overflow-hidden border-l border-[#E5E7EB] bg-white shadow-[-8px_0_24px_-12px_rgba(17,24,39,0.08)]"
    >
      <div className="shrink-0 border-b border-[#E5E7EB] px-5 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 inline-flex items-center gap-1 text-[12.5px] text-[#6B7280] hover:text-[#111827]"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Glossary
          </button>
          <button
            type="button"
            onClick={onClose}
            className="-mr-0.5 -mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded text-[#9CA3AF] hover:bg-[#F9FAFB] hover:text-[#6B7280]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <FieldPill>{row.tgtField}</FieldPill>
          <span className="font-mono text-[11.5px] text-[#6B7280]">{tgtType}</span>
          <span className="text-[#D1D5DB]">·</span>
          <span className="text-[11.5px] text-[#6B7280]">not null</span>
        </div>
        <div className="mt-1.5 font-mono text-[11px] text-[#9CA3AF]">{row.tgtTable} · target</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-[#E5E7EB] px-5 py-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#6B7280]">Business description</div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-[#374151]">
            Primary key for an engineering item; from the assembly item or part number.
          </p>
        </div>
        <GlossaryProfileBlock role="Target" field={row.tgtField} type={tgtType} profile={TARGET_PROFILE} />
        <GlossaryProfileBlock role="Source" field={row.srcField} type={srcType} profile={SOURCE_PROFILE} />
      </div>
    </aside>
  )
}

function initialProse(row: MappedMock): string {
  return row.transform.startsWith('No Transform')
    ? 'Direct pass-through from the matched source field. No transformation required.'
    : RATIONALE_PROSE[row.srcField] ?? ''
}

function seedSqlFor(row: MappedMock): string {
  return row.transform.startsWith('No Transform') ? row.srcField : `TRIM(${row.srcField})`
}

function fixSqlFor(row: MappedMock): string {
  if (row.tgtField === 'commodity_code')
    return "COALESCE((SELECT commodity_code FROM commodity_map m WHERE m.hint = s.COMM_HINT), 'UNMAPPED')"
  if (row.tgtField === 'item_description') return 'COALESCE(s.PRODUCT_NAME, s.ASSY_DESC)'
  return `COALESCE(${row.srcField}, '')`
}

interface Alternative {
  src: string
  approach: string
  conf: number
  reason: string
}

// Runner-up mappings the AI weighed but didn't pick. Surfaced only where the
// model considered real alternatives; every other field returns [] and the
// section renders its empty state.
function alternativesFor(row: MappedMock): Alternative[] {
  if (row.tgtField === 'commodity_class')
    return [
      { src: 'CLASS_CD', approach: 'pass-through', conf: 63, reason: 'Load the raw class codes unchanged — only if Rootstock accepts legacy values.' },
      { src: 'CLASS_CD + COMM_HINT', approach: 'coalesce → lookup', conf: 54, reason: 'Fall back to COMM_HINT when CLASS_CD is blank, then resolve via class_map.' },
    ]
  if (row.tgtField === 'item_description')
    return [
      { src: 'ASSY_DESC', approach: 'pass-through', conf: 58, reason: 'Use the assembly description directly; drops the marketing product name.' },
    ]
  return []
}

function MockMappingDrawer({
  row,
  index,
  total,
  reviewed,
  onToggleReviewed,
  onPrev,
  onNext,
  onClose,
}: {
  row: MappedMock
  index: number
  total: number
  reviewed: boolean
  onToggleReviewed: () => void
  onPrev: () => void
  onNext: () => void
  onClose: () => void
}) {
  const [historyOpen, setHistoryOpen] = useState(false)
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [altsOpen, setAltsOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Edit-mode + validation working state — all local and reset per row. The
  // underlying mock mappings are not mutated, so Save / Fix / Accept only
  // affect this drawer session.
  const [editing, setEditing] = useState(false)
  const [transformMode, setTransformMode] = useState<'none' | 'transform' | 'value'>(() =>
    row.transform.startsWith('No Transform') ? 'none' : 'transform',
  )
  const [sqlView, setSqlView] = useState(false)
  const [descDraft, setDescDraft] = useState(() => initialProse(row))
  const [sqlDraft, setSqlDraft] = useState(() => seedSqlFor(row))
  const [valueDraft, setValueDraft] = useState('')
  const [rationaleText, setRationaleText] = useState(() => initialProse(row))
  const [regenRat, setRegenRat] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [testing, setTesting] = useState(false)
  const [valCleared, setValCleared] = useState(false)

  useEffect(() => {
    setHistoryOpen(false)
    setGlossaryOpen(false)
    setMoreOpen(false)
    setRulesOpen(false)
    setAltsOpen(false)
    setEditing(false)
    setSqlView(false)
    setAccepted(false)
    setTesting(false)
    setValCleared(false)
    setRegenRat(false)
    setTransformMode(row.transform.startsWith('No Transform') ? 'none' : 'transform')
    setRationaleText(initialProse(row))
    setDescDraft(initialProse(row))
    setSqlDraft(seedSqlFor(row))
    setValueDraft('')
  }, [row])

  useEffect(() => {
    if (!moreOpen) return
    const onMouseDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [moreOpen])

  // Esc + click-outside close. The deferred mousedown bind keeps the opening
  // click from closing the drawer; clicks on another spec row switch rows
  // (handled by the row's own onClick) instead of closing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t) return
      if (rootRef.current && rootRef.current.contains(t)) return
      if (t.closest('[data-spec-row]')) return
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

  const srcType = SRC_TYPE[row.srcField] ?? 'VARCHAR(20)'
  const tgtType = TGT_TYPE[row.tgtField] ?? 'VARCHAR(20)'
  const isPassThrough = row.transform.startsWith('No Transform')
  const transformLabel = isPassThrough ? 'None' : row.transform.split(' · ')[0]
  const transformDetail = isPassThrough ? 'pass-through' : row.transform.split(' · ').slice(1).join(' · ')
  const issue = row.issue
  const resolved = !issue || accepted || valCleared
  // A reviewed field can always be unchecked, even if its issue reads as
  // unresolved again after reopening. Matches the design: Reviewed is a free
  // toggle once cleared; the lock only blocks the very first check.
  const canToggleReviewed = resolved || reviewed
  const alternatives = alternativesFor(row)

  const enterEdit = () => setEditing(true)
  const discard = () => {
    setTransformMode(isPassThrough ? 'none' : 'transform')
    setDescDraft(rationaleText)
    setSqlDraft(seedSqlFor(row))
    setValueDraft('')
    setSqlView(false)
    setEditing(false)
  }
  const save = () => setEditing(false)
  const generate = () => {
    setTransformMode('transform')
    setSqlDraft((s) => s || seedSqlFor(row))
    setSqlView(true)
  }
  const applyTest = () => {
    setTesting(true)
    window.setTimeout(() => {
      setValCleared(true)
      setTesting(false)
    }, 700)
  }
  const regenerateRationale = () => {
    setRegenRat(true)
    window.setTimeout(() => {
      setRationaleText((r) => `${r} Re-evaluated against the current mapping and transform.`)
      setRegenRat(false)
    }, 600)
  }
  const fix = () => {
    setTransformMode('transform')
    setSqlDraft(fixSqlFor(row))
    setDescDraft('Resolve unmatched values via lookup; default the remainder rather than loading NULL.')
    setSqlView(true)
    setAccepted(false)
    setEditing(true)
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
    if (!issue || valCleared) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] font-normal text-[#9CA3AF]">
          <Check className="h-[13px] w-[13px] shrink-0 text-[#10B981]" strokeWidth={2} />
          Passes all checks
        </div>
      )
    }
    if (accepted) {
      return (
        <div className="flex items-center gap-2 text-[12.5px] text-[#6B7280]">
          <Check className="h-[13px] w-[13px] shrink-0 text-[#9CA3AF]" strokeWidth={2} />
          Accepted with issue logged · {issue.count} row{issue.count === 1 ? '' : 's'}
          <button
            type="button"
            onClick={() => setAccepted(false)}
            className="ml-1 text-[12px] text-[#2358D4] hover:underline"
          >
            Undo
          </button>
        </div>
      )
    }
    const blocking = issue.tone === 'red'
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
              {issue.count} row{issue.count === 1 ? '' : 's'} · {issue.heading}
            </div>
            {issue.samples && issue.samples.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {issue.samples.map((v, i) => (
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

  return (
    <div ref={rootRef} className="relative flex w-full shrink-0 flex-col border-t border-[#E5E7EB] bg-white sm:block sm:w-[440px] sm:border-l sm:border-t-0"><div className="flex h-full flex-col sm:absolute sm:inset-0">
      <div className="flex h-12 items-center justify-between border-b border-[#E5E7EB] px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-block h-3.5 w-0.5 shrink-0 rounded-full bg-[#2358D4]" aria-hidden="true" />
          <span className="truncate font-mono text-[13px] font-medium text-[#111827]" title={`${row.tgtTable} · ${row.tgtField}`}>
            {row.tgtField}
          </span>
          {reviewed ? (
            <svg
              viewBox="0 0 20 20"
              className="h-[13px] w-[13px] shrink-0"
              role="img"
              aria-label="Reviewed"
            >
              <circle cx="10" cy="10" r="8.25" fill="none" stroke="#16A34A" strokeWidth="1.5" />
              <path
                d="M6.2 10.4 L8.7 12.9 L13.9 7.3"
                fill="none"
                stroke="#16A34A"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span className="h-[13px] w-[13px] shrink-0 rounded-full border border-dashed border-[#D1D5DB]" />
          )}
        </div>
        <div className="flex items-center gap-2 text-[11.5px] text-[#6B7280]">
          <span className="inline-flex items-center gap-1">
            <span className="text-[#10B981]">●</span>
            <span className="tabular-nums">{row.confidence}%</span>
          </span>
          {issue && !resolved ? (
            <span
              className="inline-flex items-center gap-1 font-medium tabular-nums"
              style={{ color: issue.tone === 'red' ? '#EF4444' : '#F59E0B' }}
              title={`${issue.count} ${issue.tone === 'red' ? 'blocking issue' : 'warning'}${issue.count === 1 ? '' : 's'}`}
            >
              <AlertTriangle className="h-3 w-3" />
              {issue.count}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setGlossaryOpen(false)
              setHistoryOpen((v) => !v)
            }}
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
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 min-w-[170px] rounded-lg border border-[#E5E7EB] bg-white p-1 shadow-[0_6px_16px_-6px_rgba(17,24,39,0.12)]"
              >
                <button
                  type="button"
                  onClick={() => {
                    setMoreOpen(false)
                    setHistoryOpen(false)
                    setGlossaryOpen(true)
                  }}
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] text-[#111827] hover:bg-[#F3F4F6]"
                >
                  <BookOpen className="h-3.5 w-3.5 text-[#6B7280]" />
                  View in glossary
                </button>
                <div className="my-1 h-px bg-[#E5E7EB]" />
                <button
                  type="button"
                  onClick={() => setMoreOpen(false)}
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
            className="inline-flex h-7 w-7 items-center justify-center rounded text-[#6B7280] hover:bg-[#F9FAFB] hover:text-[#111827]"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {historyOpen ? (
        <VersionHistoryView onBack={() => setHistoryOpen(false)} />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-5 pb-4 pt-7">
            <div className="font-mono text-[12.5px] text-[#6B7280]">
              {row.srcTable} <span className="text-[#9CA3AF]">→</span> {row.tgtTable}
            </div>
            {!editing ? (
              <button
                type="button"
                onClick={enterEdit}
                className="inline-flex items-center gap-1 text-[12px] text-[#2358D4] hover:underline"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3 px-5 pb-7">
            <div>
              <FieldPill>{row.srcField}</FieldPill>
              <div className="mt-1.5 font-mono text-[11.5px] text-[#9CA3AF]">{srcType}</div>
            </div>
            <div className="pt-1.5">
              <ArrowRight className="h-4 w-4 text-[#9CA3AF]" />
            </div>
            <div>
              <FieldPill>{row.tgtField}</FieldPill>
              <div className="mt-1.5 font-mono text-[11.5px] text-[#9CA3AF]">{tgtType}</div>
            </div>
          </div>

          {!editing ? (
            <div className="px-5 pb-4">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#1D9E75]" />
                <p className="text-[13px] leading-relaxed text-[#6B7280]">{rationaleText}</p>
              </div>
              <div className="mt-3 text-[12.5px] text-[#6B7280]">
                <span className="font-medium text-[#374151]">{transformLabel}</span>
                {transformDetail ? (
                  <>
                    <span className="mx-1 text-[#9CA3AF]">·</span>
                    <span>{transformDetail}</span>
                  </>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="px-5 pb-5">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#1D9E75]" />
                <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-[#6B7280]">
                  {regenRat ? 'Regenerating rationale…' : rationaleText}
                </p>
                <button
                  type="button"
                  onClick={regenerateRationale}
                  className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[#2358D4] hover:underline"
                >
                  <RefreshCw className={`h-3 w-3 ${regenRat ? 'animate-spin' : ''}`} />
                  Regenerate
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
                      onClick={() => setTransformMode(o.v)}
                      className={`whitespace-nowrap rounded-full px-3 py-0.5 text-[11.5px] font-medium ${transformMode === o.v ? 'bg-[#111827] text-white' : 'text-[#6B7280] hover:text-[#111827]'}`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <div className="flex-1" />
                {transformMode === 'transform' ? (
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

              {transformMode === 'none' ? (
                <div className="mt-4 text-[13px] italic text-[#6B7280]">
                  No transformation — value passes through unchanged.
                </div>
              ) : null}
              {transformMode === 'value' ? (
                <div className="mt-4">
                  <input
                    type="text"
                    value={valueDraft}
                    onChange={(e) => setValueDraft(e.target.value)}
                    placeholder="Enter value…"
                    spellCheck={false}
                    className="w-full rounded-md border border-[#E5E7EB] bg-white px-3 py-2 font-mono text-[12.5px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
                  />
                </div>
              ) : null}
              {transformMode === 'transform' ? (
                <div className="mt-4">
                  <textarea
                    value={sqlView ? sqlDraft : descDraft}
                    onChange={(e) =>
                      sqlView ? setSqlDraft(e.target.value) : setDescDraft(e.target.value)
                    }
                    placeholder='e.g., "Standardize date formats to ISO 8601"'
                    spellCheck={false}
                    rows={4}
                    className={`w-full resize-y rounded-md border border-[#E5E7EB] bg-white p-3 text-[13px] text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6] ${sqlView ? 'bg-[#F9FAFB] font-mono text-[12.5px]' : ''}`}
                  />
                </div>
              ) : null}

              {transformMode !== 'none' ? (
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
            </div>
          )}

          <div className="border-t border-[#E5E7EB] px-5 py-4">{renderValidation()}</div>

          <section className="border-t border-[#E5E7EB] px-5 py-5">
            <button
              type="button"
              onClick={() => setAltsOpen((v) => !v)}
              aria-expanded={altsOpen}
              className="flex w-full items-center gap-2 text-left text-[#6B7280] hover:text-[#111827]"
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" />
              <span className="text-[12px] font-semibold uppercase tracking-wider">
                Alternatives considered · {alternatives.length}
              </span>
              <div className="flex-1" />
              {altsOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-[#9CA3AF]" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-[#9CA3AF]" />
              )}
            </button>
            {altsOpen ? (
              alternatives.length > 0 ? (
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
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full"
                              style={{ background: a.conf >= 90 ? '#10B981' : '#F59E0B' }}
                              aria-hidden="true"
                            />
                            <span className="font-mono text-[11px] tabular-nums text-[#6B7280]">{a.conf}%</span>
                          </span>
                          <button
                            type="button"
                            className="whitespace-nowrap text-[12px] font-medium text-[#2358D4] hover:underline"
                          >
                            Use this
                          </button>
                        </div>
                      </div>
                      <div className="mt-1 text-[12.5px] leading-snug text-[#9CA3AF]">{a.reason}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 pl-[22px] text-[12.5px] italic text-[#9CA3AF]">
                  No alternatives considered.
                </div>
              )
            ) : null}
          </section>

          <section className="border-y border-[#E5E7EB] px-5 py-5">
            <button
              type="button"
              onClick={() => setRulesOpen((v) => !v)}
              aria-expanded={rulesOpen}
              className="flex w-full items-center gap-2 text-left text-[#6B7280] hover:text-[#111827]"
            >
              <Shield className="h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" />
              <span className="text-[12px] font-semibold uppercase tracking-wider">Rules · 3</span>
              <div className="flex-1" />
              {rulesOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-[#9CA3AF]" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-[#9CA3AF]" />
              )}
            </button>
            {rulesOpen ? (
              <div className="mt-3 space-y-0.5">
                {RULES.map((r) => {
                  const RuleIcon = r.origin === 'ai' ? Sparkles : User
                  return (
                    <div
                      key={r.id}
                      className="group flex items-start gap-2 rounded px-1 py-1.5 hover:bg-[#F9FAFB]"
                    >
                      <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center ${r.origin === 'ai' ? 'text-[#10B981]' : 'text-[#9CA3AF]'}`} title={r.origin === 'ai' ? 'AI-generated rule' : 'User-added rule'}>
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
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-1 text-[12px] text-[#2358D4] hover:underline"
                >
                  <Plus className="h-2.5 w-2.5" /> Add rule
                </button>
              </div>
            ) : null}
          </section>
        </div>
      )}

      {!historyOpen ? (
        <div className="flex items-center justify-between border-t border-[#E5E7EB] bg-white px-5 py-3">
          <button
            type="button"
            onClick={onPrev}
            disabled={index === 0}
            className="inline-flex items-center gap-1 text-[12.5px] text-[#6B7280] hover:text-[#374151] disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </button>
          <span className="text-[12.5px] tabular-nums text-[#9CA3AF]">
            Field {index + 1} of {total}
          </span>
          <div className="flex items-center gap-3">
            <label
              className={`inline-flex items-center gap-1.5 text-[12.5px] ${canToggleReviewed ? 'cursor-pointer text-[#6B7280]' : 'cursor-not-allowed text-[#9CA3AF]'}`}
              title={canToggleReviewed ? undefined : 'Resolve the issue (Fix or Accept) to mark reviewed'}
            >
              <input
                type="checkbox"
                checked={reviewed}
                disabled={!canToggleReviewed}
                onChange={onToggleReviewed}
                className="h-3.5 w-3.5 rounded border-[#D1D5DB] accent-[#2358D4] disabled:opacity-50"
              />
              Reviewed
            </label>
            <button
              type="button"
              onClick={onNext}
              disabled={index === total - 1}
              className="inline-flex items-center gap-1 rounded-md bg-[#2358D4] px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-[#1E47B3] disabled:opacity-40"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ) : null}
      </div>
      {glossaryOpen ? (
        <GlossaryView row={row} onBack={() => setGlossaryOpen(false)} onClose={onClose} />
      ) : null}
    </div>
  )
}

function CollapsibleSpecSection({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 border-b border-[#E5E7EB] bg-[#F9FAFB] py-2 pl-[14px] pr-6 text-[10.5px] uppercase tracking-wider text-[#6B7280] transition-colors hover:bg-[#F3F4F6]"
      >
        {open ? (
          <ChevronDown className="h-[13px] w-[13px] shrink-0 text-[#9CA3AF]" />
        ) : (
          <ChevronRight className="h-[13px] w-[13px] shrink-0 text-[#9CA3AF]" />
        )}
        <span className="font-medium tracking-wider">{label}</span>
        <span className="text-[#D1D5DB]">·</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  )
}

function MappedRow({ row, onOpen, isActive, reviewed }: { row: MappedMock; onOpen: () => void; isActive: boolean; reviewed: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const hasExtra = (row.extraSources?.length ?? 0) > 0

  return (
    <div className="spec-rowline">
      <div
        data-spec-row
        className={`relative ${GRID} min-h-[56px] cursor-pointer py-3.5 ${isActive ? 'bg-[#F9FAFB]' : 'hover:bg-[#F9FAFB]'}`}
        onClick={onOpen}
      >
        {isActive ? (
          <span className="absolute inset-y-0 left-0 w-[3px] bg-[#2358D4]" aria-hidden="true" />
        ) : null}
        <ReviewGlyph reviewed={reviewed} />
        <div className="flex min-w-0 items-center gap-2" title={row.srcTable}>
          <SystemName>{row.srcTable}</SystemName>
          <EditableFieldBadge side="source" table={row.srcTable} field={row.srcField} />
          {hasExtra ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
              className="inline-flex items-center gap-1 rounded border border-[#E5E7EB] px-1.5 py-0.5 text-[11px] text-[#6B7280] whitespace-nowrap hover:bg-[#F9FAFB]"
            >
              {expanded ? (
                <ChevronUp className="h-2.5 w-2.5 text-[#9CA3AF]" />
              ) : (
                <ChevronDown className="h-2.5 w-2.5 text-[#9CA3AF]" />
              )}
              +{row.extraSources!.length} source{row.extraSources!.length === 1 ? '' : 's'}
            </button>
          ) : null}
        </div>
        <ArrowRight className="h-3.5 w-3.5 text-[#D1D5DB]" />
        <div className="flex min-w-0 items-center gap-2" title={row.tgtTable}>
          <SystemName>{row.tgtTable}</SystemName>
          <EditableFieldBadge side="target" table={row.tgtTable} field={row.tgtField} />
        </div>
        <div className="min-w-0 truncate pl-7 text-[12.5px] text-[#6B7280]" title={row.transform}>
          {row.transform}
        </div>
        <RationalePopover rationale={row.rationale} confidence={row.confidence} srcField={row.srcField} />
        <div className="text-[11.5px]">
          {row.issue ? (
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              style={{ color: row.issue.tone === 'red' ? '#EF4444' : '#F59E0B' }}
              title={`${row.issue.count} ${row.issue.tone === 'red' ? 'blocking issue' : 'warning'}${row.issue.count === 1 ? '' : 's'}`}
            >
              <span
                className="inline-block h-[5px] w-[5px] rounded-full"
                style={{ background: row.issue.tone === 'red' ? '#EF4444' : '#F59E0B' }}
                aria-hidden="true"
              />
              {row.issue.count}
            </span>
          ) : null}
        </div>
      </div>
      {expanded && hasExtra ? (
        <div className="pb-3 pl-[60px] pr-6 -mt-1">
          {row.extraSources!.map((s, i) => (
            <div key={`${s.table}.${s.field}-${i}`} className="flex items-center gap-4 border-l border-[#E5E7EB] py-2 pl-4">
              <CornerDownRight className="h-3 w-3 shrink-0 text-[#9CA3AF]" />
              <SystemName>{s.table}</SystemName>
              <FieldPill>{s.field}</FieldPill>
              <span className="truncate text-[12px] text-[#6B7280]">{s.note}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function MockSpecTable() {
  const [open, setOpen] = useState({ mapped: true, utgt: false, usrc: false })
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  // Per-field Reviewed state, lifted here so the drawer footer checkbox and the
  // row's circular-arrow glyph stay in sync. Keyed by MAPPED index.
  const [reviewed, setReviewed] = useState<Set<number>>(new Set())
  const toggleReviewed = (i: number) =>
    setReviewed((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div className="flex w-full flex-col rounded-lg border border-[#D4D4D8] bg-white sm:flex-row">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Hairline dividers — match the design's 0.5px rules (.ml-rowline /
          .ml-underhead): a faint rule between rows and a slightly stronger one
          under the column header. Tailwind's border-b is 1px, so these are
          spelled out. */}
      <style>{`
        .spec-rowline { border-bottom: 0.5px solid #F3F4F6; }
        .spec-rowline:last-child { border-bottom: 0; }
      `}</style>
      {/* Column headers */}
      <div
        className={`${GRID} h-12 bg-white text-[11px] uppercase tracking-wider text-[#9CA3AF]`}
        style={{ borderBottom: '0.5px solid #E5E7EB' }}
      >
        <div>Source</div>
        <div />
        <div>Target</div>
        <div className="pl-7">Transformation</div>
        <div>Rationale</div>
        <div>Issues</div>
      </div>

      <CollapsibleSpecSection
        label="Mapped fields"
        count={20}
        open={open.mapped}
        onToggle={() => setOpen((s) => ({ ...s, mapped: !s.mapped }))}
      >
        {MAPPED.map((row, i) => (
          <MappedRow
            key={`${row.srcTable}.${row.srcField}`}
            row={row}
            onOpen={() => setOpenIndex(i)}
            isActive={openIndex === i}
            reviewed={reviewed.has(i)}
          />
        ))}
      </CollapsibleSpecSection>

      <CollapsibleSpecSection
        label="Unmapped target fields"
        count={7}
        open={open.utgt}
        onToggle={() => setOpen((s) => ({ ...s, utgt: !s.utgt }))}
      >
        {UNMAPPED_TARGETS.map((f) => (
          <div key={f.tgtField} className={`spec-rowline relative ${GRID} min-h-[56px] py-3.5`}>
            <ReviewGlyph />
            <div className="flex min-w-0 items-center gap-2">
              <Placeholder label="No source" />
            </div>
            <ArrowRight className="h-3.5 w-3.5 text-[#D1D5DB]" />
            <div className="flex min-w-0 items-center gap-2" title={f.tgtTable}>
              <SystemName>{f.tgtTable}</SystemName>
              <FieldPill>{f.tgtField}</FieldPill>
            </div>
            <div className="min-w-0 pl-7 text-[12.5px] text-[#9CA3AF]">—</div>
            <div className="flex min-w-0 items-center gap-2.5">
              <Tag>{f.tag}</Tag>
              <button type="button" className="shrink-0 whitespace-nowrap text-[12px] text-[#2358D4] hover:underline">
                {f.action}
              </button>
            </div>
            <div />
          </div>
        ))}
      </CollapsibleSpecSection>

      <CollapsibleSpecSection
        label="Unmapped source fields"
        count={22}
        open={open.usrc}
        onToggle={() => setOpen((s) => ({ ...s, usrc: !s.usrc }))}
      >
        {UNMAPPED_SOURCE.map((f) => (
          <div key={`${f.srcTable}.${f.srcField}`} className={`spec-rowline relative ${GRID} min-h-[56px] py-3.5`}>
            <ReviewGlyph />
            <div className="flex min-w-0 items-center gap-2" title={f.srcTable}>
              <SystemName>{f.srcTable}</SystemName>
              <FieldPill>{f.srcField}</FieldPill>
            </div>
            <ArrowRight className="h-3.5 w-3.5 text-[#D1D5DB]" />
            <div className="flex min-w-0 items-center gap-2">
              <Placeholder label="No target" />
            </div>
            <div className="min-w-0 pl-7 text-[12.5px] text-[#9CA3AF]">—</div>
            <div className="flex min-w-0 items-center gap-2.5">
              <Tag>{f.tag}</Tag>
              <button type="button" className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[12px] text-[#2358D4] hover:underline">
                Map this field <ArrowRight className="h-[11px] w-[11px]" />
              </button>
            </div>
            <div />
          </div>
        ))}
      </CollapsibleSpecSection>

        {/* Footer summary */}
        <div className="flex items-center justify-between border-t border-[#E5E7EB] px-6 py-2.5 text-[12.5px] text-[#6B7280]">
          <div>Showing 20 of 155 mappings</div>
          <div>22 unmapped source · 7 unmapped target</div>
        </div>
      </div>

      {openIndex !== null ? (
        <MockMappingDrawer
          row={MAPPED[openIndex]}
          index={openIndex}
          total={MAPPED.length}
          reviewed={reviewed.has(openIndex)}
          onToggleReviewed={() => toggleReviewed(openIndex)}
          onPrev={() => setOpenIndex((i) => (i === null ? null : Math.max(0, i - 1)))}
          onNext={() => setOpenIndex((i) => (i === null ? null : Math.min(MAPPED.length - 1, i + 1)))}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </div>
  )
}
