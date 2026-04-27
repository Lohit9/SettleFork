'use client'

// ─────────────────────────────────────────────────────────────────────────────
// EmptyMappingState — Phase 4 four-case empty-state discriminator.
// ─────────────────────────────────────────────────────────────────────────────
//
// Picks one of four sub-renders based on the project's schema-ingestion
// and TFM-population state. Subsumes the inline `EmptySchemaState` and
// `EmptyFieldsState` components that previously lived in
// `app/app/projects/[projectId]/mapping/redesign/MappingContent.tsx`.
//
// Discriminator (founder-locked, Phase 4 prompt §"Locked design decisions")
// ──────────────────────────────────────────────────────────────────────────
//
//   Case | Predicate                                                    | Render
//   1    | targetSchemaEmpty && sourceTables.length === 0               | NoSchemaState ("upload both")
//   2    | targetSchemaEmpty && sourceTables.length > 0                 | NoSchemaState ("upload target")
//   3    | !targetSchemaEmpty && (sourceTables.length===0 ||            | NoSchemaState ("upload source")
//        |   sourceFields.length===0)                                   |
//   4    | !targetSchemaEmpty && sourceTables.length > 0 &&             | GenerateMappingsState
//        |   counts.total > 0 && counts.total === counts.unmapped       |
//
// The populated case (`counts.total > counts.unmapped`) bypasses this
// component entirely — the caller renders the TargetTableGroup list as
// before. The empty/full split lives in `MappingContent.tsx`.
//
// Cases 1-3: hide the summary strip + filter row in the parent (handled
// at the call site, not here). Same for case 4.
//
// Server-side gating only
// ───────────────────────
//
// `GenerateMappingsPanel` does not gate the button client-side; failures
// surface as error toasts. See `GenerateMappingsPanel.tsx` for rationale.

import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

import { cn } from '@/components/ui/utils'
import type {
  MappingsForRedesignResult,
  SourceTableSummary,
  TargetTableSummary,
} from '@/lib/types/mappings-for-redesign'

import { GenerateMappingsPanel } from './GenerateMappingsPanel'

// ─── Discriminator ───────────────────────────────────────────────────

export type EmptyMappingCase = 1 | 2 | 3 | 4

/**
 * Pure helper: maps a `MappingsForRedesignResult` to one of the four
 * empty-state cases — or `null` when the result is in the populated
 * case (caller should render the TargetTableGroup list).
 *
 * Exported for unit tests so the discriminator math has a single
 * canonical implementation that tests can pin down without re-walking
 * the JSX.
 */
export function selectEmptyMappingCase(
  data: MappingsForRedesignResult,
): EmptyMappingCase | null {
  const sourceTablesEmpty = data.sourceTables.length === 0
  const sourceFieldsEmpty = data.sourceFields.length === 0

  if (data.targetSchemaEmpty) {
    return sourceTablesEmpty ? 1 : 2
  }
  if (sourceTablesEmpty || sourceFieldsEmpty) return 3

  // From here on, both schemas are present.
  if (data.counts.total > 0 && data.counts.total === data.counts.unmapped) {
    return 4
  }
  return null
}

// ─── Sub-renders ─────────────────────────────────────────────────────

interface NoSchemaStateProps {
  projectId: string
  variant: 1 | 2 | 3
}

const NO_SCHEMA_COPY: Record<1 | 2 | 3, { headline: string; body: string; testId: string }> = {
  1: {
    headline: 'Upload source and target schemas to begin mapping.',
    body: 'Add at least one source schema and one target schema in the Data Overview tab. Once both are present you will be able to generate AI-powered field-level mappings here.',
    testId: 'mapping-redesign-empty-no-schemas',
  },
  2: {
    headline: 'Upload a target schema to begin mapping.',
    body: 'Source schema is ready. Add a target schema in the Data Overview tab to enable AI-powered mapping generation.',
    testId: 'mapping-redesign-empty-no-target',
  },
  3: {
    headline: 'Upload a source schema to begin mapping.',
    body: 'Target schema is ready. Add a source schema in the Data Overview tab to enable AI-powered mapping generation.',
    testId: 'mapping-redesign-empty-no-source',
  },
}

function NoSchemaState({ projectId, variant }: NoSchemaStateProps) {
  const copy = NO_SCHEMA_COPY[variant]
  const href = `/app/projects/${projectId}/data-overview?tab=schema-overview`

  return (
    <div
      data-testid={copy.testId}
      className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center"
    >
      <p className="text-base font-semibold text-slate-900">
        {copy.headline}
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
        {copy.body}
      </p>
      <Link
        href={href}
        data-testid="mapping-redesign-empty-cta"
        className={cn(
          'mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors',
          'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        )}
      >
        <span>Go to Data Overview</span>
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
      </Link>
    </div>
  )
}

interface GenerateMappingsStateProps {
  projectId: string
  sourceTables: SourceTableSummary[]
  targetTables: TargetTableSummary[]
}

function GenerateMappingsState({
  projectId,
  sourceTables,
  targetTables,
}: GenerateMappingsStateProps) {
  // The redesign data contract uses different summary shapes for source
  // and target tables (TargetTableSummary carries extra status fields we
  // don't need here). Project both into the minimal `{id, name,
  // datasetName}` shape the panel expects.
  const sourceTablesForPanel = sourceTables.map((t) => ({
    id: t.id,
    name: t.name,
    datasetName: t.datasetName,
  }))
  const targetTablesForPanel = targetTables.map((t) => ({
    id: t.id,
    name: t.name,
    datasetName: t.datasetName,
  }))

  return (
    <div
      data-testid="mapping-redesign-empty-generate"
      className="flex flex-col gap-3"
    >
      <p className="text-sm text-slate-600">
        Select source and target tables, then generate field-level mappings
        with AI.
      </p>
      <GenerateMappingsPanel
        projectId={projectId}
        sourceTables={sourceTablesForPanel}
        targetTables={targetTablesForPanel}
      />
    </div>
  )
}

// ─── Public entry point ──────────────────────────────────────────────

export interface EmptyMappingStateProps {
  projectId: string
  data: MappingsForRedesignResult
}

/**
 * Discriminator component. Returns `null` when the project is in the
 * populated case — caller should render the TargetTableGroup list.
 */
export function EmptyMappingState({
  projectId,
  data,
}: EmptyMappingStateProps) {
  const variant = selectEmptyMappingCase(data)
  if (variant === null) return null

  if (variant === 4) {
    return (
      <GenerateMappingsState
        projectId={projectId}
        sourceTables={data.sourceTables}
        targetTables={data.targetTables}
      />
    )
  }

  return <NoSchemaState projectId={projectId} variant={variant} />
}
