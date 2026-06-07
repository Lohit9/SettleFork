'use client'

import { useEffect, useRef, useState } from 'react'

// On-dark mint green — scoped to this section (the page's first dark band).
// Reserved for the eyebrow + the headline values, per our color discipline.
const GREEN = '#6FE3B8'

const ROWS = [
  {
    heading: 'Time to migrate',
    sub: 'scoped end to end',
    value: (
      <>
        <span className="font-normal line-through" style={{ color: 'rgba(255,255,255,.38)', fontSize: '.5em' }}>
          months
        </span>
        <span style={{ color: 'rgba(255,255,255,.4)', fontSize: '.4em' }}>→</span>
        <span style={{ color: GREEN }}>weeks</span>
      </>
    ),
  },
  {
    heading: 'Rows validated',
    sub: 'by rule engines, not the model',
    value: <span className="text-white">Every row</span>,
  },
  {
    heading: 'Unapproved rows loaded',
    sub: 'nothing loads until sign-off',
    value: <span style={{ color: GREEN }}>0</span>,
  },
]

export default function Payoff() {
  const [active, setActive] = useState(0)
  // Off by default so the band reads at full opacity without JS / under reduced
  // motion; the scroll spotlight only dims rows once it's enabled.
  const [spotlight, setSpotlight] = useState(false)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    setSpotlight(true)

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return
          const idx = rowRefs.current.indexOf(e.target as HTMLDivElement)
          if (idx !== -1) setActive(idx)
        })
      },
      // Active zone is a line at the viewport's vertical center.
      { rootMargin: '-50% 0px -50% 0px' }
    )
    rowRefs.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <section className="relative overflow-hidden" style={{ background: 'var(--ink)' }}>
      {/* faint grid texture, fading in from the top-right */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px)',
          backgroundSize: '30px 30px',
          maskImage: 'radial-gradient(90% 130% at 100% 0%, #000, transparent 72%)',
          WebkitMaskImage: 'radial-gradient(90% 130% at 100% 0%, #000, transparent 72%)',
        }}
      />

      <div
        className="relative mx-auto max-w-[1200px] px-8"
        style={{ paddingTop: 'clamp(72px, 11vh, 132px)', paddingBottom: 'clamp(72px, 11vh, 132px)' }}
      >
        {/* eyebrow */}
        <div className="mb-1">
          <span
            className="mono inline-flex items-center gap-[9px] text-[11.5px] font-semibold uppercase tracking-[0.15em]"
            style={{ color: GREEN }}
          >
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: GREEN }} />
            THE PAYOFF
          </span>
        </div>

        {/* stat rows */}
        <div className="flex flex-col">
          {ROWS.map((row, i) => (
            <div
              key={row.heading}
              ref={(el) => {
                rowRefs.current[i] = el
              }}
              className="grid grid-cols-[1fr_auto] items-center gap-8 transition-opacity duration-500"
              style={{
                padding: 'clamp(38px, 6vh, 68px) 4px',
                borderTop: i > 0 ? '1px solid rgba(255,255,255,.1)' : 'none',
                opacity: spotlight ? (i === active ? 1 : 0.26) : 1,
              }}
            >
              <div className="min-w-0">
                <div
                  className="font-semibold tracking-[-0.015em]"
                  style={{ fontSize: 'clamp(20px, 2.4vw, 28px)', color: 'rgba(255,255,255,.96)' }}
                >
                  {row.heading}
                </div>
                <div className="mono mt-3 text-[13px]" style={{ color: 'rgba(255,255,255,.5)' }}>
                  {row.sub}
                </div>
              </div>
              <div
                className="flex items-baseline justify-end gap-4 whitespace-nowrap text-right font-[650] leading-[.95] tracking-[-0.035em] text-white"
                style={{ fontSize: 'clamp(40px, 6.4vw, 86px)' }}
              >
                {row.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
