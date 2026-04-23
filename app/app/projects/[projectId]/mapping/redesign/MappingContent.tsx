'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Mapping redesign — Phase 3 canonical home.
// ─────────────────────────────────────────────────────────────────────────────
//
// This directory is the single, canonical location for Phase 3 UI work on the
// Mapping page. All new components, hooks, and styles for the redesigned UI
// live here (or in colocated subfolders). The legacy UI at
// `../MappingContent.tsx` remains frozen except for the feature-flag dispatch
// gate at the top of its default export — see Gap 1 in
// `docs/features/mapping-redesign.md`.
//
// URL FILTER PARAM SCHEME (Phase 3, Gap 3)
//
//   The redesign uses a fresh, minimal filter param vocabulary:
//
//     ?target=<table-id>       — scope to a single target table
//     ?source=<table-id>       — scope to a single source table
//     ?status=<value>          — status filter (all | needs_review | approved | unmapped)
//     ?q=<search>              — free-text field-name search
//
//   Back-compat note (founder decision, out-of-band, 2026-04-21): the legacy
//   params `?fields=<ids>` and `?type=<mapping-type>` are NOT translated into
//   the new scheme. The redesign hard-resets filter state on first load; no
//   shim, no migration layer. Users who bookmarked legacy URLs will land on
//   the default (unfiltered) view. This keeps the new state machine clean and
//   avoids permanent coupling to the legacy filter vocabulary.
//
// CURRENT STATE (Gap 4c)
//
//   Diagnostic panel from Gap 4b is replaced with real target-table groups
//   and minimal read-only field rows. No filters, no drawer, no chevron —
//   Gaps 3, 5, 6, 7-10 layer those in. The amber WIP banner is retained at
//   the top until the full redesign ships.

import { useMemo } from 'react'
import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'
import type {
  MappingRow,
  MappingsForRedesignResult,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'
import { TargetTableGroup } from './components/TargetTableGroup'

interface Props {
  projectId: string
  projectName: string
  projectInfo?: ProjectInfo
  /**
   * Data feed for the redesigned Mapping page. Null only when
   * `page.tsx` was unable to fetch (unauth or project missing), in
   * which case the UI renders an inline error state. Populated on
   * all happy-path renders under the `use_mapping_redesign` flag.
   */
  initialRedesignData: MappingsForRedesignResult | null
}

export default function MappingRedesignContent({
  projectId,
  projectName,
  projectInfo,
  initialRedesignData,
}: Props) {
  return (
    <div className="flex h-full flex-col bg-gray-50">
      <PageHeader
        projectName={projectName}
        title="Mapping"
        projectInfo={projectInfo}
      />
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <WipBanner projectId={projectId} />
          {initialRedesignData === null ? (
            <NoDataState />
          ) : (
            <MappingBody data={initialRedesignData} />
          )}
        </div>
      </div>
    </div>
  )
}

// ─── WIP banner ──────────────────────────────────────────────────────────────

function WipBanner({ projectId }: { projectId: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="mapping-redesign-placeholder"
      className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
    >
      <span className="font-semibold">Mapping redesign — Phase 3 in progress.</span>{' '}
      You are viewing the experimental redesigned Mapping UI behind the{' '}
      <code className="rounded bg-amber-100 px-1 py-0.5">use_mapping_redesign</code>{' '}
      feature flag. Project <span className="font-mono">{projectId}</span>.
    </div>
  )
}

// ─── Body ────────────────────────────────────────────────────────────────────

function MappingBody({ data }: { data: MappingsForRedesignResult }) {
  /**
   * Group rows by target-table id WHILE preserving server order. We
   * rely on Map insertion order (the server emits rows sorted by
   * targetTable.name ASC + ordinalPosition ASC), so the Map's native
   * iteration yields groups in canonical order too. No client sort —
   * that would violate the data-contract ordering guarantee.
   */
  const groupedRows = useMemo(() => groupRowsByTargetTable(data.rows), [data.rows])
  const tablesById = useMemo(() => {
    const m = new Map<string, TargetTableSummary>()
    for (const t of data.targetTables) m.set(t.id, t)
    return m
  }, [data.targetTables])

  return (
    <>
      <CountersRow counts={data.counts} tableCount={data.targetTables.length} />

      {data.targetSchemaEmpty ? (
        <EmptySchemaState />
      ) : groupedRows.size === 0 ? (
        <EmptyFieldsState />
      ) : (
        <div className="flex flex-col gap-4">
          {Array.from(groupedRows.entries()).map(([targetTableId, rows]) => {
            const summary = tablesById.get(targetTableId)
            if (!summary) return null
            return (
              <TargetTableGroup
                key={targetTableId}
                targetTable={summary}
                rows={rows}
              />
            )
          })}
        </div>
      )}
    </>
  )
}

// ─── Counters row ────────────────────────────────────────────────────────────
// Inline pipe-separated stats, matching the spec mockup (line 646) and the
// existing pattern in components/app/ProjectsList.tsx.

function CountersRow({
  counts,
  tableCount,
}: {
  counts: MappingsForRedesignResult['counts']
  tableCount: number
}) {
  const chips: { label: string; value: number }[] = [
    { label: 'Total', value: counts.total },
    { label: 'Approved', value: counts.approved },
    { label: 'Needs Review', value: counts.needsReview },
  ]
  // §9 Q6 (2026-04-22): show the Rejected chip only when the count is non-zero.
  if (counts.rejected > 0) {
    chips.push({ label: 'Rejected', value: counts.rejected })
  }

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500"
      data-testid="mapping-redesign-counters"
    >
      {chips.map((chip, i) => (
        <span key={chip.label} className="flex items-center gap-3">
          {i > 0 ? <span aria-hidden="true" className="text-gray-300">·</span> : null}
          <span>
            <span className="font-medium text-gray-700">{chip.label}</span>{' '}
            <span className="tabular-nums">{chip.value}</span>
          </span>
        </span>
      ))}
      <span aria-hidden="true" className="text-gray-300">·</span>
      <span className="tabular-nums" data-testid="mapping-redesign-table-count">
        {tableCount} {tableCount === 1 ? 'table' : 'tables'}
      </span>
    </div>
  )
}

// ─── Empty / error states ────────────────────────────────────────────────────

function NoDataState() {
  return (
    <div
      data-testid="mapping-redesign-no-data"
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-600"
    >
      Unable to load mapping data. The project may be unavailable or you may
      not have access — try refreshing or returning to the project list.
    </div>
  )
}

function EmptySchemaState() {
  return (
    <div
      data-testid="mapping-redesign-empty-schema"
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-600"
    >
      No target schema has been defined yet for this project. Once target
      tables are added, their fields will appear here for mapping.
    </div>
  )
}

function EmptyFieldsState() {
  return (
    <div
      data-testid="mapping-redesign-empty-fields"
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center text-sm text-slate-600"
    >
      No fields to display.
    </div>
  )
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Group server-sorted rows by target-table id. Returns a Map so iteration
 * order matches the rows' arrival order (canonical server order).
 */
function groupRowsByTargetTable(rows: MappingRow[]): Map<string, MappingRow[]> {
  const out = new Map<string, MappingRow[]>()
  for (const row of rows) {
    const tableId = row.targetField.targetTable.id
    const existing = out.get(tableId)
    if (existing) existing.push(row)
    else out.set(tableId, [row])
  }
  return out
}
