'use client'

import { useEffect, useRef, useState } from 'react'
import { useScroll, useMotionValueEvent, useReducedMotion } from 'framer-motion'

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
    heading: 'Errors at cutover',
    sub: 'flags resolved before anything loads',
    value: <span style={{ color: GREEN }}>0</span>,
  },
]

export default function Payoff() {
  const trackRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const [active, setActive] = useState(0)

  // Spotlight is off until mounted (so the no-JS / SSR markup is full opacity)
  // and stays off under reduced motion — both cases show every row at full.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const spotlight = mounted && !reduceMotion

  // Pinned scrollytelling: scrolling the tall track steps the lit row 0→1→2.
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start start', 'end end'],
  })
  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const next = Math.min(2, Math.max(0, Math.floor(p * ROWS.length)))
    setActive((prev) => (prev === next ? prev : next))
  })

  return (
    <section className="relative">
      {/* tall track — ~one viewport per row */}
      <div ref={trackRef} className="relative h-[300vh]">
        {/* pinned dark band, below the 64px header, content centered */}
        <div
          className="sticky top-16 overflow-hidden"
          style={{ height: 'calc(100vh - 4rem)', background: 'var(--ink)' }}
        >
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

          <div className="relative flex h-full flex-col justify-center">
            <div className="mx-auto w-full max-w-[1200px] px-8">
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
                    className="grid grid-cols-[1fr_auto] items-center gap-8 transition-opacity duration-[250ms] ease-out"
                    style={{
                      padding: 'clamp(30px, 5.4vh, 68px) 4px',
                      borderTop: i > 0 ? '1px solid rgba(255,255,255,.1)' : 'none',
                      opacity: spotlight ? (i === active ? 1 : 0.26) : 1,
                    }}
                  >
                    <div className="min-w-0">
                      <div
                        className="font-semibold tracking-[-0.015em]"
                        style={{ fontSize: 'clamp(20px, min(2.4vw, 3.4vh), 28px)', color: 'rgba(255,255,255,.96)' }}
                      >
                        {row.heading}
                      </div>
                      <div
                        className="mono text-[13px]"
                        style={{ marginTop: 'clamp(6px, 1.4vh, 12px)', color: 'rgba(255,255,255,.5)' }}
                      >
                        {row.sub}
                      </div>
                    </div>
                    <div
                      className="flex items-baseline justify-end gap-4 whitespace-nowrap text-right font-[650] leading-[.95] tracking-[-0.035em] text-white"
                      style={{ fontSize: 'clamp(40px, min(6.4vw, 10vh), 86px)' }}
                    >
                      {row.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
