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
// CURRENT STATE (Gap 4b)
//
//   Placeholder body still renders the "Phase 3 in progress" banner, and now
//   ALSO renders a diagnostic panel that surfaces the key stats of the
//   `MappingsForRedesignResult` payload fetched by `getMappingsForRedesign`.
//   The diagnostic panel is a temporary smoke-test aid — Gap 4c replaces it
//   with the real target-table-grouped UI. It MUST NOT leak into the final
//   Gap 4c UI: when 4c lands, replace the <DiagnosticPanel /> call with the
//   real target-table view.

import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'
import type {
  MappingRowKind,
  MappingsForRedesignResult,
} from '@/lib/types/mappings-for-redesign'

interface Props {
  projectId: string
  projectName: string
  projectInfo?: ProjectInfo
  /**
   * Data feed for the redesigned Mapping page. Null only when
   * `page.tsx` was unable to fetch (unauth or project missing), in
   * which case the UI renders the diagnostic banner with a "no data"
   * indicator. Populated on all happy-path renders under the
   * `use_mapping_redesign` flag.
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
    <div className="flex flex-col h-full">
      <PageHeader
        projectName={projectName}
        title="Mapping"
        projectInfo={projectInfo}
      />
      <div className="flex-1 overflow-auto p-6">
        <div
          role="status"
          aria-live="polite"
          className="max-w-2xl mx-auto mt-8 rounded-lg border border-amber-300 bg-amber-50 px-6 py-5 text-amber-900"
          data-testid="mapping-redesign-placeholder"
        >
          <div className="text-base font-semibold">
            Mapping redesign — Phase 3 in progress
          </div>
          <p className="mt-2 text-sm text-amber-800">
            You are viewing the experimental redesigned Mapping UI. The full
            implementation is being landed incrementally under the
            <code className="mx-1 rounded bg-amber-100 px-1 py-0.5 text-xs">
              use_mapping_redesign
            </code>
            feature flag.
          </p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-amber-900/80">
            <dt className="font-medium">Project ID</dt>
            <dd className="font-mono">{projectId}</dd>
            <dt className="font-medium">Project name</dt>
            <dd>{projectName}</dd>
          </dl>
        </div>

        <DiagnosticPanel data={initialRedesignData} />
      </div>
    </div>
  )
}

// ─── Diagnostic panel (Gap 4b, temporary) ────────────────────────────────────
// Surfaces the key fields of `MappingsForRedesignResult` so Gap 4b can be
// smoke-tested end-to-end without the final UI. Gap 4c deletes this.

function DiagnosticPanel({ data }: { data: MappingsForRedesignResult | null }) {
  if (data === null) {
    return (
      <div
        data-testid="mapping-redesign-diagnostic-empty"
        className="max-w-2xl mx-auto mt-6 rounded-lg border border-slate-200 bg-slate-50 px-6 py-5 text-sm text-slate-600"
      >
        No mapping data fetched. The server action returned{' '}
        <code className="rounded bg-slate-100 px-1 py-0.5">null</code> —
        either the viewer is unauthenticated or the project was not
        resolvable at render time.
      </div>
    )
  }

  const rowCountByKind = countByKind(data.rows)

  return (
    <div
      data-testid="mapping-redesign-diagnostic-panel"
      className="max-w-2xl mx-auto mt-6 rounded-lg border border-slate-200 bg-white px-6 py-5 shadow-sm"
    >
      <div className="text-sm font-semibold text-slate-800">
        Redesign data payload (diagnostic)
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Temporary smoke-test view of <code>MappingsForRedesignResult</code>.
        Replaced by the target-table-grouped UI in Gap 4c.
      </p>

      <dl className="mt-4 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="font-medium text-slate-600">rowCount</dt>
        <dd className="font-mono text-slate-800">{data.rows.length}</dd>

        <dt className="font-medium text-slate-600">rowCountByKind</dt>
        <dd className="font-mono text-slate-800">
          {formatKindCounts(rowCountByKind)}
        </dd>

        <dt className="font-medium text-slate-600">counts.total</dt>
        <dd className="font-mono text-slate-800">{data.counts.total}</dd>

        <dt className="font-medium text-slate-600">counts.approved</dt>
        <dd className="font-mono text-slate-800">{data.counts.approved}</dd>

        <dt className="font-medium text-slate-600">counts.needsReview</dt>
        <dd className="font-mono text-slate-800">{data.counts.needsReview}</dd>

        <dt className="font-medium text-slate-600">counts.rejected</dt>
        <dd className="font-mono text-slate-800">{data.counts.rejected}</dd>

        <dt className="font-medium text-slate-600">counts.unmapped</dt>
        <dd className="font-mono text-slate-800">{data.counts.unmapped}</dd>

        <dt className="font-medium text-slate-600">targetTableCount</dt>
        <dd className="font-mono text-slate-800">{data.targetTables.length}</dd>

        <dt className="font-medium text-slate-600">sourceTableCount</dt>
        <dd className="font-mono text-slate-800">{data.sourceTables.length}</dd>

        <dt className="font-medium text-slate-600">sourceFieldAcks</dt>
        <dd className="font-mono text-slate-800">
          {data.sourceFieldAcknowledgments.length}
        </dd>

        <dt className="font-medium text-slate-600">targetSchemaEmpty</dt>
        <dd className="font-mono text-slate-800">
          {String(data.targetSchemaEmpty)}
        </dd>
      </dl>
    </div>
  )
}

function countByKind(
  rows: MappingsForRedesignResult['rows'],
): Record<MappingRowKind, number> {
  const out: Record<MappingRowKind, number> = {
    mapped: 0,
    value_assignment: 0,
    target_acknowledged: 0,
    unmapped: 0,
  }
  for (const row of rows) {
    out[row.kind]++
  }
  return out
}

function formatKindCounts(counts: Record<MappingRowKind, number>): string {
  return `mapped=${counts.mapped}  va=${counts.value_assignment}  ack=${counts.target_acknowledged}  unmapped=${counts.unmapped}`
}
