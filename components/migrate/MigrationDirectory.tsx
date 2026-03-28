'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'

interface MigrationPage {
  slug: string
  source_system: string
  target_system: string
  source_category: string | null
  target_category: string | null
  display_order: number | null
}

interface Props {
  pages: MigrationPage[]
}

export default function MigrationDirectory({ pages }: Props) {
  const [sourceFilter, setSourceFilter] = useState('')
  const [targetFilter, setTargetFilter] = useState('')

  const sourceOptions = useMemo(
    () => [...new Set(pages.map((p) => p.source_system))].sort(),
    [pages]
  )
  const targetOptions = useMemo(
    () => [...new Set(pages.map((p) => p.target_system))].sort(),
    [pages]
  )

  const hasFilter = sourceFilter !== '' || targetFilter !== ''

  const filteredPages = useMemo(() => {
    return pages.filter((p) => {
      if (sourceFilter && p.source_system !== sourceFilter) return false
      if (targetFilter && p.target_system !== targetFilter) return false
      return true
    })
  }, [pages, sourceFilter, targetFilter])

  const groups = useMemo(() => {
    if (hasFilter) return null
    const map = new Map<string, MigrationPage[]>()
    for (const p of filteredPages) {
      if (!map.has(p.target_system)) map.set(p.target_system, [])
      map.get(p.target_system)!.push(p)
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [filteredPages, hasFilter])

  const clearFilters = () => {
    setSourceFilter('')
    setTargetFilter('')
  }

  const selectCls =
    'rounded-lg border border-mine-slate-200 px-4 py-2.5 text-sm text-mine-slate-700 bg-white min-w-[200px] focus:outline-none focus:border-mine-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all'

  return (
    <>
      {/* ── Filter Bar ──────────────────────────────────────── */}
      <div className="sticky top-16 z-10 bg-white border-b border-mine-slate-200 py-4 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
          <span className="text-sm font-medium text-mine-slate-700 shrink-0">Find your migration</span>

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className={selectCls}
          >
            <option value="">Any source system</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            value={targetFilter}
            onChange={(e) => setTargetFilter(e.target.value)}
            className={selectCls}
          >
            <option value="">Any target system</option>
            {targetOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <span className="text-sm text-mine-slate-400 sm:ml-auto shrink-0">
            {filteredPages.length} migration path{filteredPages.length !== 1 ? 's' : ''}
          </span>

          {hasFilter && (
            <button
              onClick={clearFilters}
              className="text-sm text-mine-blue-600 hover:text-mine-blue-500 cursor-pointer shrink-0"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Results ─────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 lg:px-12 py-10">
        {filteredPages.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-mine-slate-500">No migration paths match your filters.</p>
            <p className="text-sm text-mine-slate-400 mt-2">
              Try adjusting your source or target system, or{' '}
              <button onClick={clearFilters} className="text-mine-blue-600 hover:text-mine-blue-500">
                clear filters
              </button>
              .
            </p>
          </div>
        ) : hasFilter ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredPages.map((page) => (
              <Card key={page.slug} page={page} />
            ))}
          </div>
        ) : (
          <div className="space-y-12">
            {groups!.map(([targetSystem, rows]) => (
              <div key={targetSystem}>
                <h2 className="text-xl font-bold text-mine-slate-900 mb-4">
                  Migrate to {targetSystem}
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {rows.map((page) => (
                    <Card key={page.slug} page={page} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

function Card({ page }: { page: { slug: string; source_system: string; target_system: string; source_category: string | null } }) {
  return (
    <Link
      href={`/migrate/${page.slug}`}
      className="border border-mine-slate-200 rounded-xl p-5 hover:border-mine-blue-400 hover:shadow-md transition-all flex flex-col gap-1"
    >
      <p className="text-base font-semibold text-mine-slate-900">{page.source_system}</p>
      <p className="text-sm text-mine-teal-600">→ {page.target_system}</p>
      {page.source_category && (
        <span className="self-start text-xs text-mine-slate-500 bg-mine-slate-100 px-2 py-0.5 rounded mt-2 inline-block">
          {page.source_category}
        </span>
      )}
    </Link>
  )
}
