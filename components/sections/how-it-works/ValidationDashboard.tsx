'use client'

import { useState, useEffect, useRef } from 'react'
import { useInView } from 'framer-motion'

const TARGET_SCORE = 87
const RADIUS = 32
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const CHECKS = [
  { icon: '✅', name: 'Schema compatibility',        count: '3,412 / 3,412' },
  { icon: '✅', name: 'Referential integrity',        count: '847 / 847' },
  { icon: '⚠️', name: 'Target constraint validation', count: '38 / 47 resolved' },
  { icon: '✅', name: 'Picklist alignment',           count: '24 / 24' },
  { icon: '🔴', name: 'Null handling',                count: '9 blocking issues' },
]

function gaugeStroke(score: number): string {
  if (score > 80) return '#14B8A6'
  if (score > 60) return '#F59E0B'
  return '#F87171'
}

export default function ValidationDashboard() {
  const ref = useRef<HTMLDivElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-80px' })
  const [score, setScore] = useState(0)
  const hasStarted = useRef(false)

  useEffect(() => {
    if (!isInView || hasStarted.current) return
    hasStarted.current = true

    const interval = setInterval(() => {
      setScore((prev) => {
        const next = prev + 2
        if (next >= TARGET_SCORE) {
          clearInterval(interval)
          return TARGET_SCORE
        }
        return next
      })
    }, 30)

    return () => clearInterval(interval)
  }, [isInView])

  const dashOffset = CIRCUMFERENCE - (score / 100) * CIRCUMFERENCE
  const stroke = gaugeStroke(score)

  return (
    <div ref={ref} className="bg-[#0F172A] rounded-xl overflow-hidden font-mono text-xs">
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-[#1E293B]">
        <div className="w-2 h-2 rounded-full bg-[#EF4444]" />
        <div className="w-2 h-2 rounded-full bg-[#F59E0B]" />
        <div className="w-2 h-2 rounded-full bg-[#22C55E]" />
        <span className="text-[#64748B] text-[11px] ml-2">
          Validation dashboard — customers migration
        </span>
      </div>

      <div className="px-4 py-4">
        {/* Gauge + text row */}
        <div className="flex items-center gap-5 mb-4">
          {/* Circular gauge */}
          <div className="relative shrink-0" style={{ width: 80, height: 80 }}>
            <svg width="80" height="80" className="-rotate-90">
              {/* Track */}
              <circle
                cx="40" cy="40" r={RADIUS}
                fill="none"
                stroke="#1E293B"
                strokeWidth="6"
              />
              {/* Progress */}
              <circle
                cx="40" cy="40" r={RADIUS}
                fill="none"
                stroke={stroke}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={dashOffset}
                style={{ transition: 'stroke-dashoffset 0.05s linear, stroke 0.3s ease' }}
              />
            </svg>
            {/* Center label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-white text-xl font-semibold leading-none font-sans">
                {score}
              </span>
              <span className="text-[#64748B] text-[8px] tracking-widest mt-0.5 font-sans">
                READY
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <p className="text-[#E2E8F0] text-sm font-medium font-sans leading-snug">
              Migration readiness score
            </p>
            <p className="text-[#64748B] text-xs mt-1 font-sans">
              9 blocking issues remaining before go-live
            </p>
          </div>
        </div>

        {/* Checklist */}
        <div>
          {CHECKS.map((check) => (
            <div key={check.name} className="flex items-center gap-3 py-2 border-t border-[#1E293B]">
              <span className="text-sm leading-none">{check.icon}</span>
              <span className="text-[#CBD5E1] text-xs flex-1 font-sans">{check.name}</span>
              <span className="text-[#64748B] text-xs font-mono">{check.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
