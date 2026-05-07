import { cn } from '@/components/ui/utils'
import type { MappingCardinality, TfmPathDEnrichment } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// MappingDetailsPanel — Path D primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Standalone additive panel surfacing the 5 Path D enrichment columns added
// to target_field_mappings by migration 093 (lines 354-369):
//
//   • transformation_intent  — free-form prose (no enum, line 355)
//   • mapping_cardinality    — '1:1' | 'many_to_one' | 'one_to_many' |
//                              'many_to_many' (CHECK at line 358-360)
//   • dedup_required         — boolean (default FALSE, line 363)
//   • dedup_strategy         — JSONB (DedupStrategy shape, line 366)
//   • data_quality_flag_ids  — JSONB array of DQ issue IDs (line 369)
//
// This component is NOT integrated into the existing MappingDrawer; it's
// scaffolded for plug-in by a follow-up PR after Phase B server actions
// land. Pure prop-driven, no internal data fetching.

const CARDINALITY_LABEL: Record<MappingCardinality, string> = {
  '1:1': '1:1',
  many_to_one: 'Many → one',
  one_to_many: 'One → many',
  many_to_many: 'Many → many',
}

interface MappingDetailsPanelProps {
  enrichment: TfmPathDEnrichment
  className?: string
}

export function MappingDetailsPanel({
  enrichment,
  className,
}: MappingDetailsPanelProps) {
  const {
    transformation_intent,
    mapping_cardinality,
    dedup_required,
    dedup_strategy,
    data_quality_flag_ids,
  } = enrichment

  return (
    <section
      data-testid='mapping-details-panel'
      className={cn(
        'flex flex-col gap-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm',
        className,
      )}
    >
      <header>
        <h3 className='text-base font-semibold text-slate-900 leading-tight'>
          Mapping details
        </h3>
      </header>

      {/* Transformation intent — free-form prose */}
      <section className='flex flex-col gap-2'>
        <h4 className='text-xs font-semibold uppercase tracking-wide text-slate-500'>
          Transformation intent
        </h4>
        {transformation_intent ? (
          <p
            data-testid='transformation-intent'
            className='text-sm text-slate-700 leading-relaxed'
          >
            {transformation_intent}
          </p>
        ) : (
          <p className='text-sm text-slate-400 italic'>Not yet inferred.</p>
        )}
      </section>

      {/* Mapping cardinality — badge */}
      <section className='flex flex-col gap-2'>
        <h4 className='text-xs font-semibold uppercase tracking-wide text-slate-500'>
          Cardinality
        </h4>
        {mapping_cardinality ? (
          <span
            data-testid='mapping-cardinality'
            data-cardinality={mapping_cardinality}
            className='inline-flex w-fit items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700'
          >
            {CARDINALITY_LABEL[mapping_cardinality]}
          </span>
        ) : (
          <p className='text-sm text-slate-400 italic'>Not yet inferred.</p>
        )}
      </section>

      {/* Dedup — required flag + strategy preview */}
      <section className='flex flex-col gap-2'>
        <h4 className='text-xs font-semibold uppercase tracking-wide text-slate-500'>
          Dedup
        </h4>
        <div className='flex items-center gap-2'>
          <span
            data-testid='dedup-required'
            data-required={dedup_required}
            className={cn(
              'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
              dedup_required
                ? 'bg-amber-50 text-amber-800 border-amber-200'
                : 'bg-slate-100 text-slate-600 border-slate-200',
            )}
          >
            {dedup_required ? 'Required' : 'Not required'}
          </span>
        </div>
        {dedup_required && dedup_strategy ? (
          <pre
            data-testid='dedup-strategy'
            className='text-xs leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3 overflow-x-auto text-slate-800 mt-1'
          >
            {JSON.stringify(dedup_strategy, null, 2)}
          </pre>
        ) : null}
      </section>

      {/* Data quality flags — count only at scaffolding stage */}
      <section className='flex flex-col gap-2'>
        <h4 className='text-xs font-semibold uppercase tracking-wide text-slate-500'>
          Data quality flags
        </h4>
        <p
          data-testid='dq-flag-count'
          data-count={data_quality_flag_ids.length}
          className='text-sm text-slate-700'
        >
          {data_quality_flag_ids.length === 0
            ? 'No flags raised.'
            : `${data_quality_flag_ids.length} flag${data_quality_flag_ids.length === 1 ? '' : 's'} raised.`}
        </p>
      </section>
    </section>
  )
}
