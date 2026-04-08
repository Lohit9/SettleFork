'use client'

import { useMemo, useState, useRef, useEffect } from 'react'
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

  return (
    <>
      {/* ── Filter Bar ──────────────────────────────────────── */}
      <div className="sticky top-16 z-10 bg-white border-b border-settle-slate-200 py-4 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center gap-3 sm:gap-4">
          <span className="text-sm font-medium text-settle-slate-700 shrink-0">Find your migration</span>

          <CustomSelect
            value={sourceFilter}
            onChange={setSourceFilter}
            placeholder="Any source system"
            options={sourceOptions}
          />

          <CustomSelect
            value={targetFilter}
            onChange={setTargetFilter}
            placeholder="Any target system"
            options={targetOptions}
          />

          <span className="text-sm text-settle-slate-400 sm:ml-auto shrink-0">
            {filteredPages.length} migration path{filteredPages.length !== 1 ? 's' : ''}
          </span>

          {hasFilter && (
            <button
              onClick={clearFilters}
              className="text-sm text-settle-blue-600 hover:text-settle-blue-500 cursor-pointer shrink-0"
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
            <p className="text-settle-slate-500">No migration paths match your filters.</p>
            <p className="text-sm text-settle-slate-400 mt-2">
              Try adjusting your source or target system, or{' '}
              <button onClick={clearFilters} className="text-settle-blue-600 hover:text-settle-blue-500">
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
                <h2 className="text-xl font-bold text-settle-slate-900 mb-4">
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

function CustomSelect({
  value,
  onChange,
  placeholder,
  options,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  options: string[]
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (open) {
      setSearch('')
      setTimeout(() => searchRef.current?.focus(), 0)
    }
  }, [open])

  const filtered = options.filter((o) =>
    o.toLowerCase().includes(search.toLowerCase())
  )

  const handleSelect = (v: string) => {
    onChange(v)
    setOpen(false)
    setSearch('')
  }

  return (
    <div ref={ref} className="relative min-w-[220px]">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-left hover:border-gray-300 focus:outline-none transition-all"
      >
        <span className={value ? 'text-gray-900' : 'text-gray-400'}>{value || placeholder}</span>
        <svg
          className={`w-4 h-4 text-gray-400 shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[240px] rounded-lg border border-gray-200 bg-white shadow-xl overflow-hidden">
          {/* Search input */}
          <div className="px-3 pt-3 pb-2 border-b border-gray-100">
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5">
              <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full bg-transparent text-sm text-gray-700 placeholder:text-gray-400 focus:outline-none"
              />
              {search && (
                <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* List with fade scroll indicator */}
          <div className="relative">
            <ul ref={listRef} className="max-h-52 overflow-y-auto py-1 scroll-smooth">
              {!search && (
                <li>
                  <button
                    type="button"
                    onClick={() => handleSelect('')}
                    className={`w-full flex items-center justify-between px-4 py-2 text-sm text-left hover:bg-gray-50 transition-colors ${value === '' ? 'text-[#2358D4] font-medium' : 'text-gray-400'}`}
                  >
                    {placeholder}
                    {value === '' && (
                      <svg className="w-4 h-4 text-[#2358D4] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                </li>
              )}
              {filtered.length === 0 ? (
                <li className="px-4 py-3 text-sm text-gray-400 text-center">No results</li>
              ) : (
                filtered.map((opt) => (
                  <li key={opt}>
                    <button
                      type="button"
                      onClick={() => handleSelect(opt)}
                      className={`w-full flex items-center justify-between px-4 py-2 text-sm text-left hover:bg-gray-50 transition-colors ${value === opt ? 'text-[#2358D4] font-medium' : 'text-gray-700'}`}
                    >
                      {opt}
                      {value === opt && (
                        <svg className="w-4 h-4 text-[#2358D4] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  </li>
                ))
              )}
            </ul>
            {/* Fade indicator at bottom to signal more items */}
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-white to-transparent" />
          </div>
        </div>
      )}
    </div>
  )
}

function Card({ page }: { page: { slug: string; source_system: string; target_system: string; source_category: string | null } }) {
  return (
    <Link
      href={`/migrate/${page.slug}`}
      className="border border-settle-slate-200 rounded-xl p-5 hover:border-settle-blue-400 hover:shadow-md transition-all flex flex-col gap-1"
    >
      <p className="text-base font-semibold text-settle-slate-900">{page.source_system}</p>
      <p className="text-sm text-settle-teal-600">→ {page.target_system}</p>
      {page.source_category && (
        <span className="self-start text-xs text-settle-slate-500 bg-settle-slate-100 px-2 py-0.5 rounded mt-2 inline-block">
          {page.source_category}
        </span>
      )}
    </Link>
  )
}
