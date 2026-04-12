'use client'

import { useState, useEffect, useRef } from 'react'
import { useInView } from 'framer-motion'

const ROWS = [
  { field: 'customer_id',   type: 'INT',            nullPct: '0%',    sample: '10042, 10043, 10044' },
  { field: 'cust_name',     type: 'VARCHAR(120)',    nullPct: '2.1%',  sample: 'Acme Corp, Republic Svc' },
  { field: 'service_addr',  type: 'VARCHAR(255)',    nullPct: '14.3%', sample: '142 Main St, PO Box 881' },
  { field: 'acct_status',   type: 'CHAR(1)',         nullPct: '0%',    sample: 'A, I, S, P' },
  { field: 'last_pickup_dt',type: 'DATETIME',        nullPct: '8.7%',  sample: '2024-11-15, 2025-01-02' },
  { field: 'monthly_rate',  type: 'DECIMAL(10,2)',   nullPct: '0.4%',  sample: '284.50, 1200.00' },
]

function nullColor(pct: string) {
  return parseFloat(pct) >= 10 ? 'text-yellow-400' : 'text-green-400'
}

export default function SchemaTable() {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })
  const [visibleCount, setVisibleCount] = useState(0)
  const [showBanner, setShowBanner] = useState(false)
  const hasStarted = useRef(false)

  useEffect(() => {
    if (!isInView || hasStarted.current) return
    hasStarted.current = true

    let count = 0
    const interval = setInterval(() => {
      count += 1
      setVisibleCount(count)
      if (count >= ROWS.length) {
        clearInterval(interval)
        setTimeout(() => setShowBanner(true), 200)
      }
    }, 180)

    return () => clearInterval(interval)
  }, [isInView])

  return (
    <div ref={ref} className="bg-slate-900 rounded-xl overflow-hidden font-mono text-xs">
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-slate-800">
        <div className="w-2 h-2 rounded-full bg-red-500" />
        <div className="w-2 h-2 rounded-full bg-amber-500" />
        <div className="w-2 h-2 rounded-full bg-green-500" />
        <span className="text-slate-500 text-xs ml-2">
          Schema profiler — legacy_waste_mgmt.customers
        </span>
      </div>

      {/* Table */}
      <div className="px-4 py-3">
        {/* Header */}
        <div className="grid grid-cols-[1.6fr_1.4fr_0.6fr_2fr] border-b border-slate-800 pb-2 mb-1">
          {['Field', 'Type', 'Nulls', 'Sample values'].map((h) => (
            <span key={h} className="text-slate-500 text-2xs uppercase tracking-widest">
              {h}
            </span>
          ))}
        </div>

        {/* Rows */}
        {ROWS.map((row, i) => (
          <div
            key={row.field}
            className="grid grid-cols-[1.6fr_1.4fr_0.6fr_2fr] py-2 border-b border-slate-800 last:border-b-0 transition-opacity duration-300"
            style={{ opacity: i < visibleCount ? 1 : 0 }}
          >
            <span className="text-blue-300">{row.field}</span>
            <span className="text-slate-400">{row.type}</span>
            <span className={nullColor(row.nullPct)}>{row.nullPct}</span>
            <span className="text-slate-500 truncate">{row.sample}</span>
          </div>
        ))}

        {/* Success banner */}
        <div
          className="bg-teal-600/10 rounded-lg p-2 mt-3 transition-opacity duration-500"
          style={{ opacity: showBanner ? 1 : 0 }}
        >
          <span className="text-teal-300 text-xs">
            ✓ Profiled 240 tables · 3,412 fields · 847K rows in 14 seconds
          </span>
        </div>
      </div>
    </div>
  )
}
